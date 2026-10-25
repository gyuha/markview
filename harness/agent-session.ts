// 에이전트 패널의 대화 이어가기 — 같은 탭에서 연달아 보내면 출력이 쌓이고, "새 대화"로 끊고, 탭을 닫으면 정리한다.
// 대화를 CLI의 세션으로 이어 주는 일은 Rust가 한다(웹뷰는 세션 ID를 모른다). 실제 DOM 이벤트로 구동하고 DOM과 모킹 IPC 호출 기록으로만 판정한다.
// 판정할 ID는 harness/required-agent.txt(U01~U05).
// 계약: `[data-agent-new]` · IPC `reset_agent_session {path}` · `run_agent {preset,prompt,text,path}` · 출력 줄 `[data-kind=user|status|…]`
import { calls, check, emitTauri, guard, openTab, ready, respond, tabs, visible, wait, waitFor } from "./lib-muya";

type Run = { args: Record<string, unknown>; resolve: (text: string) => void; reject: (msg: string) => void };
const runs: Run[] = [];

const $ = (sel: string, root: ParentNode = document) => root.querySelector<HTMLElement>(sel);
const part = (name: string) => $(`[data-agent-${name}]`);
const text = (el: Element | null | undefined) => (el?.textContent ?? "").trim();
const callsOf = (cmd: string) => calls().filter((c) => c.cmd === cmd);
/** 줄 앞의 표시 기호(`›` `·` `▸` …)는 글자가 아니다. */
const body = (el: HTMLElement) => text(el).replace(/^[›·▸…⚠✗]\s*/, "");
const entries = () => [...document.querySelectorAll<HTMLElement>("[data-agent-log] > [data-kind]")].map((e) => [e.dataset.kind, body(e)] as const);
const users = () => entries().filter((e) => e[0] === "user").map((e) => e[1]);

async function send(prompt: string): Promise<Run | null> {
  const before = runs.length;
  const el = part("prompt") as HTMLTextAreaElement;
  el.value = prompt;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  (part("send") as HTMLElement).click();
  return waitFor(() => (runs.length > before ? runs[runs.length - 1] : null), 3000);
}

async function main(): Promise<void> {
  await ready();
  respond("detect_agents", () => [
    { id: "claude", name: "Claude Code", path: "/x/claude" },
    { id: "codex", name: "Codex", path: "/x/codex" },
  ]);
  respond("run_agent", (args) => new Promise<string>((resolve, reject) => runs.push({ args: args ?? {}, resolve, reject: (m) => reject(m) })));
  respond("cancel_agent", () => null);
  respond("reset_agent_session", () => null);
  const [tab] = tabs();
  const emit = (kind: string, line: string) => emitTauri("agent-log", { path: tab.path, stream: "out", kind, line });

  $("#toolbar-right [data-agent-toggle]")!.click();
  await waitFor(() => visible(part("prompt")), 5000);
  await wait(300);

  // U03의 앞부분 — 출력이 없으면 "새 대화"는 보이지 않는다.
  const hiddenWhenEmpty = !!part("new") && !visible(part("new"));

  // 첫 전송 → 단계·답 → 완료(변경 없음으로 끝내 검토 단계가 입력을 막지 않게 한다).
  const run1 = await send("첫 질문");
  emit("tool", "문서를 읽는 중");
  emit("message", "첫 답입니다.");
  await wait(100);
  const duringDisabled = (part("new") as HTMLButtonElement).disabled;
  run1?.resolve(tab.source);
  await waitFor(() => part("status")?.dataset.state === "ok", 3000);
  (part("discard") as HTMLElement | null)?.click();
  await wait(100);

  // U01 — 두 번째 전송
  const run2 = await send("두 번째 질문");
  emit("message", "두 번째 답입니다.");
  await wait(100);
  const e = entries();
  const texts = e.map((x) => x[1]).join("|");
  check(
    "U01",
    "두 번째 전송 뒤에도 첫 전송의 출력이 남고 새 지시가 그 아래에 쌓인다",
    users().join(",") === "첫 질문,두 번째 질문" && texts.includes("문서를 읽는 중") && texts.includes("첫 답입니다.") && texts.indexOf("첫 답입니다.") < texts.indexOf("두 번째 질문") && texts.includes("두 번째 답입니다."),
    `users=${users()} texts=${texts}`,
  );
  // U02
  const keys = (r: Run | null) => JSON.stringify(Object.keys(r?.args ?? {}).sort());
  check("U02", "이어서 보낼 때도 `run_agent` 인자 키는 path·preset·prompt·text 네 개뿐이다", keys(run1) === keys(run2) && keys(run2) === JSON.stringify(["path", "preset", "prompt", "text"]), `first=${keys(run1)} second=${keys(run2)}`);
  run2?.resolve(tab.source);
  await waitFor(() => part("status")?.dataset.state === "ok", 3000);
  (part("discard") as HTMLElement | null)?.click();
  await wait(100);

  // U05 — 프로바이더를 바꾸면 새 대화 표시, 같으면 없음
  const noticeBefore = entries().filter((x) => x[1].includes("새 대화로 시작합니다")).length;
  (part("preset") as HTMLSelectElement).value = "codex";
  (part("preset") as HTMLSelectElement).dispatchEvent(new Event("change", { bubbles: true }));
  const run3 = await send("프로바이더를 바꾼 질문");
  const noticeAfter = entries().filter((x) => x[1].includes("새 대화로 시작합니다")).length;
  run3?.resolve(tab.source);
  await waitFor(() => part("status")?.dataset.state === "ok", 3000);
  (part("discard") as HTMLElement | null)?.click();
  await wait(100);
  const run4 = await send("같은 프로바이더로 한 번 더");
  const noticeSame = entries().filter((x) => x[1].includes("새 대화로 시작합니다")).length;
  run4?.resolve(tab.source);
  await waitFor(() => part("status")?.dataset.state === "ok", 3000);
  (part("discard") as HTMLElement | null)?.click();
  await wait(100);
  check("U05", "프로바이더를 바꿔 보내면 '새 대화로 시작합니다' 줄이 나오고 같은 프로바이더로 보내면 나오지 않는다", noticeBefore === 0 && noticeAfter === 1 && noticeSame === 1, `before=${noticeBefore} afterSwitch=${noticeAfter} afterSame=${noticeSame}`);

  // U03 — 새 대화
  const visibleWithOutput = visible(part("new"));
  const baseReset = callsOf("reset_agent_session").length;
  (part("new") as HTMLElement).click();
  await wait(150);
  const resets = callsOf("reset_agent_session").slice(baseReset);
  const cleared = entries().length === 0 && !visible(part("status")) && !visible(part("new"));
  const run5 = await send("새 대화의 첫 질문");
  const afterNew = users();
  run5?.resolve(tab.source);
  await waitFor(() => part("status")?.dataset.state === "ok", 3000);
  (part("discard") as HTMLElement | null)?.click();
  check(
    "U03",
    "새 대화는 출력이 있을 때만 보이고 실행 중엔 비활성이며, 누르면 `reset_agent_session`이 `{ path }`로 1번 불리고 출력이 비워지며 그 뒤 첫 전송에는 이전 전송이 없다",
    hiddenWhenEmpty && duringDisabled && visibleWithOutput && resets.length === 1 && JSON.stringify(resets[0].args) === JSON.stringify({ path: tab.path }) && cleared && afterNew.join(",") === "새 대화의 첫 질문",
    `hiddenWhenEmpty=${hiddenWhenEmpty} duringDisabled=${duringDisabled} visible=${visibleWithOutput} resets=${JSON.stringify(resets.map((c) => c.args))} cleared=${cleared} afterNew=${afterNew}`,
  );

  // U04 — 탭을 닫으면 정리
  const second = await openTab("/tmp/harness-2.md");
  await waitFor(() => second && second.source.length > 0, 5000);
  second!.button.click();
  await wait(200);
  const baseClose = callsOf("reset_agent_session").length;
  ($(".tab-close", second!.button) as HTMLElement | null)?.click();
  await wait(300);
  const closeResets = callsOf("reset_agent_session").slice(baseClose);
  check("U04", "탭을 닫으면 `reset_agent_session`이 그 탭의 경로로 불린다", closeResets.length === 1 && (closeResets[0].args as { path?: string }).path === "/tmp/harness-2.md", `calls=${JSON.stringify(closeResets.map((c) => c.args))}`);
}

void guard(main);

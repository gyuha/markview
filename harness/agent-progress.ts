// 에이전트 패널의 진행 표시 — 보낸 지시·진행 단계·답이 출력 상자에 차례로 쌓이고, 상태 줄이 실행 중인 일과 경과 시간을 보이며,
// Enter로 보내고 출력을 복사한다. 실제 DOM 이벤트로 구동하고 DOM과 모킹 IPC 호출 기록으로만 판정한다.
// 판정할 ID는 harness/required-agent.txt(Q01~Q11).
// 계약: `[data-agent-status]`(`data-state`=running|ok|error|cancelled) · `[data-agent-log]` 안의 줄 `[data-kind=user|status|thinking|tool|message|warning|error|raw]`
//   · `[data-agent-copy]` · `[data-agent-prompt]`(Enter 전송) · 이벤트 `agent-log {path, stream, kind?, line}`
//   · 클립보드 IPC `plugin:clipboard-manager|write_text {text}`.
import { calls, check, emitTauri, guard, openTab, ready, respond, tabs, visible, wait, waitFor } from "./lib-muya";

type Run = { args: Record<string, unknown>; resolve: (text: string) => void; reject: (msg: string) => void };
const runs: Run[] = [];

const $ = (sel: string, root: ParentNode = document) => root.querySelector<HTMLElement>(sel);
const part = (name: string) => $(`[data-agent-${name}]`);
const text = (el: Element | null | undefined) => (el?.textContent ?? "").trim();
const callsOf = (cmd: string) => calls().filter((c) => c.cmd === cmd);
const logEntries = () => [...document.querySelectorAll<HTMLElement>("[data-agent-log] > [data-kind]")].map((e) => [e.dataset.kind, text(e)] as const);
const prompt = () => part("prompt") as HTMLTextAreaElement;

function setPrompt(value: string): void {
  prompt().value = value;
  prompt().dispatchEvent(new Event("input", { bubbles: true }));
}

function press(init: KeyboardEventInit & { keyCode?: number }): boolean {
  const e = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init });
  if (init.keyCode !== undefined) Object.defineProperty(e, "keyCode", { value: init.keyCode });
  prompt().dispatchEvent(e);
  return e.defaultPrevented;
}

const elapsedOf = () => {
  const m = /(\d\d):(\d\d)/.exec(text(part("status")));
  return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
};

async function main(): Promise<void> {
  await ready();
  respond("detect_agents", () => [{ id: "claude", name: "Claude Code", path: "/x/claude" }]);
  respond("run_agent", (args) => new Promise<string>((resolve, reject) => runs.push({ args: args ?? {}, resolve, reject: (m) => reject(m) })));
  respond("cancel_agent", () => null);
  const [t1] = tabs();

  document.querySelector<HTMLElement>("#toolbar-right [data-agent-toggle]")!.click();
  await waitFor(() => visible(prompt()), 5000);
  await wait(300);

  // Q08 — Enter 전송. 조합 중·Shift·빈 입력은 보내지 않는다.
  setPrompt("한 줄 덧붙여 줘");
  const shift = press({ shiftKey: true });
  const composing = press({ isComposing: true });
  const ime = press({ keyCode: 229 });
  await wait(100);
  const notSent = runs.length === 0 && prompt().value === "한 줄 덧붙여 줘" && !shift && !composing && !ime;
  setPrompt("   ");
  press({});
  await wait(100);
  const emptyNoop = runs.length === 0;
  setPrompt("한 줄 덧붙여 줘");
  const plain = press({});
  await waitFor(() => runs.length > 0, 3000);
  const run1 = runs[0];
  check(
    "Q08",
    "Enter는 `run_agent`를 1번 부르고 입력 상자를 비운다. Shift+Enter·조합 중 Enter·빈 입력은 보내지 않는다",
    notSent && emptyNoop && plain && runs.length === 1 && callsOf("run_agent").length === 1 && prompt().value === "" && run1?.args.prompt === "한 줄 덧붙여 줘",
    `notSent=${notSent} emptyNoop=${emptyNoop} plainPrevented=${plain} runs=${runs.length} value=${JSON.stringify(prompt().value)}`,
  );
  if (!run1) return;

  // Q01·Q05 — 보내자마자 상태 줄과 지시 줄이 있다(IPC는 아직 끝나지 않았다).
  const status = text(part("status"));
  const entries = logEntries();
  check(
    "Q01",
    "보내자마자 상태 줄에 '실행 중'·프로바이더 이름·경과 시간·현재 단계가 있다",
    visible(part("status")) && part("status")!.dataset.state === "running" && status.includes("실행 중") && status.includes("Claude Code") && /\d\d:0\d/.test(status) && status.includes("요청을 보내는 중"),
    `status=${JSON.stringify(status)} state=${part("status")?.dataset.state}`,
  );
  check(
    "Q05",
    "보낸 지시가 출력 상자 맨 위에 user 줄로 보이고 그 아래에 '요청을 보냈습니다' 줄이 있다",
    entries[0]?.[0] === "user" && entries[0]?.[1].includes("한 줄 덧붙여 줘") && entries[1]?.[0] === "status" && entries[1]?.[1].includes("Claude Code에 요청을 보냈습니다"),
    `entries=${JSON.stringify(entries)}`,
  );

  // Q03·Q04 — 이벤트 종류별 줄
  const emit = (kind: string | undefined, line: string, stream = "out") => emitTauri("agent-log", { path: t1.path, stream, ...(kind ? { kind } : {}), line });
  emit("status", "에이전트를 시작했습니다");
  emit("thinking", "생각하는 중");
  emit("tool", "문서를 읽는 중");
  await wait(120);
  const afterTool = text(part("status"));
  const kinds = logEntries().map((e) => e[0]);
  check(
    "Q03",
    "kind별로 줄이 쌓이고 상태 줄의 현재 단계가 마지막 단계의 글자로 바뀐다",
    kinds.join(",") === "user,status,status,thinking,tool" && afterTool.includes("문서를 읽는 중"),
    `kinds=${kinds} status=${JSON.stringify(afterTool)}`,
  );
  emit(undefined, "plain cli line");
  emit("message", "한 줄을 덧붙였습니다.");
  emit("message", "한 줄을 덧붙였습니다.");
  emit("error", "도구가 실패했습니다");
  await wait(120);
  const after = logEntries();
  check(
    "Q04",
    "kind 없는 줄은 raw, message·error는 각각 구별되고 똑같은 줄이 연달아 오면 하나만 남는다",
    after.slice(-3).map((e) => e[0]).join(",") === "raw,message,error" && after.filter((e) => e[0] === "message").length === 1,
    `tail=${JSON.stringify(after.slice(-4))}`,
  );

  // Q02 — 경과 시간이 흐른다.
  const t0 = elapsedOf();
  await wait(1300);
  const t2 = elapsedOf();
  check("Q02", "경과 시간은 시간이 지나면 늘어난다", t0 >= 0 && t2 > t0, `before=${t0} after=${t2}`);

  // Q07 — 탭을 옮겼다 와도 유지된다.
  const second = await openTab("/tmp/harness-2.md");
  await waitFor(() => second && second.source.length > 0, 5000);
  second!.button.click();
  await wait(200);
  const otherEmpty = logEntries().length === 0 && !visible(part("status"));
  t1.button.click();
  await wait(1100);
  const back = logEntries();
  const elapsedBack = elapsedOf();
  check(
    "Q07",
    "다른 탭에서는 출력이 비어 있고, 돌아오면 이 탭의 출력과 흐르는 경과 시간이 그대로 있다",
    otherEmpty && back.length === after.length && back[0]?.[0] === "user" && elapsedBack >= t2 && part("status")!.dataset.state === "running",
    `otherEmpty=${otherEmpty} back=${back.length}/${after.length} elapsed=${elapsedBack}/${t2}`,
  );

  // Q10 — 복사
  const copyBtn = part("copy") as HTMLButtonElement;
  const beforeCopy = callsOf("plugin:clipboard-manager|write_text").length;
  copyBtn.click();
  await waitFor(() => callsOf("plugin:clipboard-manager|write_text").length > beforeCopy, 3000);
  await wait(100);
  const copied = callsOf("plugin:clipboard-manager|write_text").slice(beforeCopy);
  const sentText = String((copied[0]?.args as { text?: string } | undefined)?.text ?? "");
  const expected = ["> 한 줄 덧붙여 줘", "Claude Code에 요청을 보냈습니다", "에이전트를 시작했습니다", "생각하는 중", "문서를 읽는 중", "plain cli line", "한 줄을 덧붙였습니다.", "도구가 실패했습니다"];
  check(
    "Q10",
    "복사는 출력 상자의 글 전체로 클립보드 쓰기를 1번 부르고 단추가 '복사됨'이 된다",
    copied.length === 1 && expected.every((e) => sentText.includes(e)) && sentText.startsWith("> 한 줄 덧붙여 줘") && text(copyBtn) === "복사됨",
    `calls=${copied.length} text=${JSON.stringify(sentText)} label=${text(copyBtn)}`,
  );

  // Q06 + Q09(성공) — 끝나면 완료, 입력 상자는 빈 채.
  run1.resolve(`${t1.source}추가된 줄\n`);
  await waitFor(() => part("status")?.dataset.state === "ok", 3000);
  await wait(100);
  const doneText = text(part("status"));
  const frozen = elapsedOf();
  await wait(1300);
  const frozenLater = elapsedOf();
  const promptAfterOk = prompt().value;
  (part("reject") as HTMLElement | null)?.click();
  await wait(100);

  // Q09(실패·취소) + Q06(실패·취소) — 지시가 입력 상자로 돌아온다.
  const beforeErr = runs.length;
  setPrompt("실패할 지시");
  press({});
  await waitFor(() => runs.length > beforeErr, 3000);
  runs[runs.length - 1].reject("에이전트가 오류로 끝났습니다(exit status: 1)");
  await waitFor(() => part("status")?.dataset.state === "error", 3000);
  await wait(100);
  const failText = text(part("status"));
  const restoredError = prompt().value === "실패할 지시";
  const errEntries = logEntries();
  const beforeCancel = runs.length;
  press({});
  await waitFor(() => runs.length > beforeCancel, 3000);
  (part("cancel") as HTMLElement).click();
  runs[runs.length - 1].reject("취소했습니다");
  await waitFor(() => part("status")?.dataset.state === "cancelled", 3000);
  await wait(100);
  const cancelText = text(part("status"));
  const restoredCancel = prompt().value === "실패할 지시";
  check(
    "Q06",
    "끝나면 상태 줄이 '완료'로 바뀌고 경과 시간이 멈춘다. 오류는 '실패', 취소는 '취소됨'",
    doneText.includes("완료") && frozen >= 0 && frozen === frozenLater && failText.includes("실패") && cancelText.includes("취소됨") && errEntries[errEntries.length - 1]?.[0] === "error",
    `done=${JSON.stringify(doneText)} frozen=${frozen}/${frozenLater} fail=${JSON.stringify(failText)} cancel=${JSON.stringify(cancelText)}`,
  );
  check(
    "Q09",
    "실패·취소하면 보낸 지시가 입력 상자로 돌아오고, 성공해서 검토 단계로 가면 입력 상자는 빈 채다",
    promptAfterOk === "" && restoredError && restoredCancel,
    `afterOk=${JSON.stringify(promptAfterOk)} restoredError=${restoredError} restoredCancel=${restoredCancel}`,
  );

  // Q11 — 다시 실행은 입력 상자가 비어 있어도 직전 지시로 부른다.
  setPrompt("고칠 지시");
  press({});
  await waitFor(() => runs.length > beforeCancel + 1, 3000);
  const runR = runs[runs.length - 1];
  // 실행 중 문서가 바뀌게 해 '다시 실행'이 나오게 한다.
  t1.button.click();
  const { EditorView } = await import("@codemirror/view");
  document.querySelector<HTMLElement>('#view-mode [data-mode="split"]')!.click();
  await wait(250);
  const view = EditorView.findFromDOM(t1.editorHost)!;
  view.dispatch({ changes: { from: view.state.doc.length, insert: "사용자가 고친 줄\n" } });
  await wait(100);
  runR.resolve(`${t1.source}에이전트 줄\n`);
  await waitFor(() => !!part("rerun") && visible(part("rerun")), 3000);
  const emptyBefore = prompt().value === "";
  const baseRerun = callsOf("run_agent").length;
  (part("rerun") as HTMLElement).click();
  await wait(200);
  const rerun = callsOf("run_agent").slice(baseRerun);
  check(
    "Q11",
    "다시 실행은 입력 상자가 비어 있어도 직전에 보낸 지시로 `run_agent`를 부른다",
    emptyBefore && rerun.length === 1 && (rerun[0].args as { prompt?: string }).prompt === "고칠 지시",
    `emptyBefore=${emptyBefore} calls=${JSON.stringify(rerun.map((c) => (c.args as { prompt?: string }).prompt))}`,
  );
  runs[runs.length - 1]?.reject("취소했습니다");
}

void guard(main);

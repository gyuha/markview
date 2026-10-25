// 에이전트 패널의 질의 말풍선 — 내가 보낸 질의를 에이전트의 단계·답과 구별해 보이고, 시각·복사·입력 상자로 되돌리기를 둔다.
// 실제 DOM 이벤트로 구동하고 DOM·계산된 스타일·모킹 IPC 호출 기록으로만 판정한다. 판정할 ID는 harness/required-agent.txt(V01~V06).
// 계약: 출력 상자 `[data-agent-log]` 안의 `[data-kind=user]`(말풍선) 바로 뒤 형제 `.agent-meta`(`[data-agent-time]`·`[data-agent-entry-redo]`·`[data-agent-entry-copy]`)
//   · `[data-kind=message]` 줄 안의 `[data-agent-entry-copy]` · 클립보드 IPC `plugin:clipboard-manager|write_text {text}`.
import { calls, check, emitTauri, guard, ready, respond, tabs, visible, wait, waitFor } from "./lib-muya";

type Run = { args: Record<string, unknown>; resolve: (text: string) => void; reject: (msg: string) => void };
const runs: Run[] = [];

const $ = (sel: string, root: ParentNode = document) => root.querySelector<HTMLElement>(sel);
const all = (sel: string, root: ParentNode = document) => [...root.querySelectorAll<HTMLElement>(sel)];
const part = (name: string) => $(`[data-agent-${name}]`);
const text = (el: Element | null | undefined) => (el?.textContent ?? "").trim();
const clip = () => calls().filter((c) => c.cmd === "plugin:clipboard-manager|write_text");
const bubbles = () => all('[data-agent-log] > [data-kind="user"]');
const metaOf = (bubble: HTMLElement) => bubble.nextElementSibling as HTMLElement | null;

async function send(prompt: string): Promise<Run | null> {
  const before = runs.length;
  const el = part("prompt") as HTMLTextAreaElement;
  el.value = prompt;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  (part("send") as HTMLElement).click();
  return waitFor(() => (runs.length > before ? runs[runs.length - 1] : null), 3000);
}

const transparent = (el: Element) => {
  const bg = getComputedStyle(el).backgroundColor;
  return bg === "rgba(0, 0, 0, 0)" || bg === "transparent";
};

async function main(): Promise<void> {
  await ready();
  respond("detect_agents", () => [{ id: "claude", name: "Claude Code", path: "/x/claude" }]);
  respond("run_agent", (args) => new Promise<string>((resolve, reject) => runs.push({ args: args ?? {}, resolve, reject: (m) => reject(m) })));
  respond("cancel_agent", () => null);
  respond("reset_agent_session", () => null);
  const [tab] = tabs();
  const emit = (kind: string, line: string) => emitTauri("agent-log", { path: tab.path, stream: "out", kind, line });

  $("#toolbar-right [data-agent-toggle]")!.click();
  await waitFor(() => visible(part("prompt")), 5000);
  await wait(300);

  // 첫 질의 — 실행 중 상태에서 단계와 답을 쌓는다.
  const run1 = await send("요약을 제거 해 주세요.");
  emit("tool", "문서를 읽는 중");
  emit("message", "요약 섹션을 제거했습니다.");
  await wait(150);

  // V01 — 말풍선은 배경색이 있고 둥글다. 단계·답 줄은 배경이 없다.
  const b1 = bubbles()[0];
  const step = $('[data-agent-log] > [data-kind="tool"]')!;
  const answer = $('[data-agent-log] > [data-kind="message"]')!;
  const status = $('[data-agent-log] > [data-kind="status"]')!;
  const radius = parseFloat(getComputedStyle(b1).borderTopLeftRadius);
  check(
    "V01",
    "질의는 배경색이 있고 둥근 말풍선이며, 단계·답·상태 줄은 배경이 투명하다",
    !!b1 && !transparent(b1) && radius > 0 && transparent(step) && transparent(answer) && transparent(status),
    `bubbleBg=${b1 && getComputedStyle(b1).backgroundColor} radius=${radius} step=${getComputedStyle(step).backgroundColor} answer=${getComputedStyle(answer).backgroundColor}`,
  );

  // V02 — 시각
  const time = $("[data-agent-time]", metaOf(b1) ?? document);
  check("V02", "말풍선 아래에 요일과 오전/오후 시:분이 보인다", !!time && visible(time) && /[일월화수목금토]요일 (오전|오후) \d{1,2}:\d{2}/.test(text(time)), `time=${JSON.stringify(text(time))}`);

  // V04(실행 중 비활성) — 아직 실행 중이다.
  const redoRunning = $("[data-agent-entry-redo]", metaOf(b1) ?? document) as HTMLButtonElement | null;
  const disabledWhileRunning = !!redoRunning && redoRunning.disabled;

  // V03 — 복사
  const copyBtn = $("[data-agent-entry-copy]", metaOf(b1) ?? document) as HTMLButtonElement | null;
  const base3 = clip().length;
  copyBtn?.click();
  await waitFor(() => clip().length > base3, 3000);
  await wait(80);
  const made3 = clip().slice(base3);
  check(
    "V03",
    "복사 아이콘은 그 질의의 글 하나만으로 클립보드 쓰기를 1번 부르고 잠시 복사됨 표시가 된다",
    !!copyBtn && made3.length === 1 && (made3[0].args as { text?: string }).text === "요약을 제거 해 주세요." && copyBtn.dataset.copied === "true",
    `calls=${JSON.stringify(made3.map((c) => c.args))} copied=${copyBtn?.dataset.copied}`,
  );

  // V05 — 답의 복사
  const answerCopy = $("[data-agent-entry-copy]", answer) as HTMLButtonElement | null;
  const base5 = clip().length;
  answerCopy?.click();
  await waitFor(() => clip().length > base5, 3000);
  const made5 = clip().slice(base5);
  check("V05", "답 줄의 복사 아이콘은 그 답의 글만 복사한다", !!answerCopy && made5.length === 1 && (made5[0].args as { text?: string }).text === "요약 섹션을 제거했습니다.", `calls=${JSON.stringify(made5.map((c) => c.args))}`);

  // 첫 실행을 끝내고 두 번째·세 번째 질의를 보낸다.
  run1?.resolve(tab.source);
  await waitFor(() => part("status")?.dataset.state === "ok", 3000);
  (part("discard") as HTMLElement | null)?.click();
  await wait(100);
  const run2 = await send("원본으로 복원 해 주세요.");
  run2?.resolve(tab.source);
  await waitFor(() => part("status")?.dataset.state === "ok", 3000);
  (part("discard") as HTMLElement | null)?.click();
  await wait(100);
  const run3 = await send("세 번째 질의입니다.\n두 줄로 씁니다.");
  run3?.resolve(tab.source);
  await waitFor(() => part("status")?.dataset.state === "ok", 3000);
  (part("discard") as HTMLElement | null)?.click();
  await wait(100);

  // V06 — 말풍선 여러 개: 순서와 각자의 글, 복사·되돌리기는 눌린 것에만.
  const bs = bubbles();
  const order = bs.map((b) => text(b));
  const second = bs[1];
  const base6 = clip().length;
  ($("[data-agent-entry-copy]", metaOf(second)!) as HTMLElement).click();
  await waitFor(() => clip().length > base6, 3000);
  const copied6 = (clip()[clip().length - 1].args as { text?: string }).text;
  const third = bs[2];
  const prompt = part("prompt") as HTMLTextAreaElement;
  ($("[data-agent-entry-redo]", metaOf(third)!) as HTMLElement).click();
  await wait(120);
  const redoFilled = prompt.value === "세 번째 질의입니다.\n두 줄로 씁니다." && document.activeElement === prompt;
  check(
    "V06",
    "말풍선은 보낸 순서대로 각자의 글을 담고 복사·되돌리기는 눌린 말풍선의 질의에만 적용된다",
    order.length === 3 && order[0] === "요약을 제거 해 주세요." && order[1] === "원본으로 복원 해 주세요." && order[2].startsWith("세 번째 질의입니다.") && copied6 === "원본으로 복원 해 주세요." && redoFilled,
    `order=${JSON.stringify(order)} copied=${JSON.stringify(copied6)} redoFilled=${redoFilled} active=${document.activeElement?.tagName}`,
  );

  // V04 — 되돌리기는 입력 상자를 채우고 포커스를 주며, 실행 중에는 비활성이다.
  prompt.value = "";
  prompt.dispatchEvent(new Event("input", { bubbles: true }));
  ($("[data-agent-entry-redo]", metaOf(bubbles()[0])!) as HTMLElement).click();
  await wait(100);
  const filledFirst = prompt.value === "요약을 제거 해 주세요." && document.activeElement === prompt;
  const run4 = await send(prompt.value);
  await wait(100);
  const stillDisabled = all("[data-agent-entry-redo]").every((b) => (b as HTMLButtonElement).disabled);
  run4?.resolve(tab.source);
  await waitFor(() => part("status")?.dataset.state === "ok", 3000);
  (part("discard") as HTMLElement | null)?.click();
  await wait(100);
  const enabledAgain = all("[data-agent-entry-redo]").every((b) => !(b as HTMLButtonElement).disabled);
  check(
    "V04",
    "되돌리기 아이콘은 그 질의를 입력 상자에 채우고 포커스를 주며, 실행 중에는 비활성이다",
    filledFirst && disabledWhileRunning && stillDisabled && enabledAgain,
    `filledFirst=${filledFirst} runningFirst=${disabledWhileRunning} running=${stillDisabled} after=${enabledAgain}`,
  );
}

void guard(main);

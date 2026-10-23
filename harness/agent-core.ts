// AI 에이전트 패널 — 실제 DOM 이벤트(클릭·입력)로 구동하고 DOM과 모킹 IPC 호출 기록으로만 판정한다.
// `node harness/run.mjs agent` 가 돌린다. 판정할 ID는 harness/required-agent.txt.
// 계약: 툴바 `[data-agent-toggle]` · 패널 `[data-agent-panel]` · `[data-agent-preset]`(select) · `[data-agent-prompt]`(textarea)
//   · `[data-agent-send]` · `[data-agent-cancel]` · `[data-agent-log]` · `[data-agent-error]` · `[data-agent-diff]`(안의 줄은 `[data-line="add|del"]`)
//   · `[data-agent-accept]` · `[data-agent-reject]` · `[data-agent-discard]` · `[data-agent-rerun]` · `[data-agent-stale]` · `[data-agent-nochange]`
//   · IPC `detect_agents` · `run_agent {preset,prompt,text,path}` · `cancel_agent {path}` · 이벤트 `agent-log {path,stream,line}`.
import { EditorView } from "@codemirror/view";
import { calls, check, clickMode, editorDoc, emitTauri, guard, muyaOf, openTab, ready, respond, tabs, visible, wait, waitFor } from "./lib-muya";

const params = new URLSearchParams(location.search);

type Detected = { id: string; name: string; path: string | null };
type Run = { args: Record<string, unknown>; resolve: (text: string) => void; reject: (msg: string) => void };

const runs: Run[] = [];
const FOUND: Detected[] = [
  { id: "claude", name: "Claude Code", path: "/x/claude" },
  { id: "codex", name: "Codex", path: "/x/codex" },
  { id: "opencode", name: "OpenCode", path: null },
];

const $ = (sel: string, root: ParentNode = document) => root.querySelector<HTMLElement>(sel);
const panel = () => $("[data-agent-panel]");
const part = (name: string) => $(`[data-agent-${name}]`);
const shown = (name: string) => visible(part(name));
const enabled = (name: string) => {
  const el = part(name) as HTMLButtonElement | null;
  return !!el && !el.disabled && visible(el);
};
const callsOf = (cmd: string) => calls().filter((c) => c.cmd === cmd);
const text = (el: Element | null | undefined) => (el?.textContent ?? "").trim();

function setPrompt(value: string): void {
  const el = part("prompt") as HTMLTextAreaElement;
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/** 지시를 쓰고 보낸 뒤 모킹된 `run_agent` 호출이 생길 때까지 기다려 그 실행을 돌려준다. */
async function startRun(prompt: string): Promise<Run | null> {
  const before = runs.length;
  setPrompt(prompt);
  (part("send") as HTMLElement).click();
  return waitFor(() => (runs.length > before ? runs[runs.length - 1] : null), 3000);
}

function activate(path: string): void {
  tabs().find((t) => t.path === path)!.button.click();
}

const cmContent = (tab: ReturnType<typeof tabs>[number]) => editorDoc(tab);

async function main(): Promise<void> {
  // 자식 창: "에이전트를 하나도 못 찾는" 환경만 만든다. 검사는 부모가 한다.
  if (params.has("none")) {
    respond("detect_agents", () => FOUND.map((a) => ({ ...a, path: null })));
    return;
  }

  await ready();
  respond("detect_agents", () => FOUND);
  respond("run_agent", (args) => new Promise<string>((resolve, reject) => runs.push({ args: args ?? {}, resolve, reject: (m) => reject(m) })));
  respond("cancel_agent", () => null);

  const [t1] = tabs();
  const baseText = t1.source;

  // A01 — 시작·탭 전환만으로는 호출이 없다.
  const toggle = $("#toolbar-right [data-agent-toggle]");
  const second = await openTab("/tmp/harness-2.md");
  await waitFor(() => second && second.source.length > 0, 5000);
  for (const t of tabs()) {
    t.button.click();
    await wait(60);
  }
  activate(t1.path);
  check(
    "A01",
    "툴바에 `[data-agent-toggle]` 버튼 하나, `aria-pressed` false, 패널은 숨김, 시작·탭 전환만으로는 `detect_agents`·`run_agent`가 불리지 않는다",
    document.querySelectorAll("#toolbar-right [data-agent-toggle]").length === 1 &&
      toggle?.getAttribute("aria-pressed") === "false" &&
      !visible(panel()) &&
      callsOf("detect_agents").length === 0 &&
      callsOf("run_agent").length === 0,
    `toggle=${!!toggle} pressed=${toggle?.getAttribute("aria-pressed")} panel=${visible(panel())} detect=${callsOf("detect_agents").length}`,
  );
  if (!toggle) return;

  // A02
  toggle.click();
  await waitFor(() => visible(panel()), 5000);
  await waitFor(() => callsOf("detect_agents").length >= 1, 3000);
  await wait(150);
  const afterOpen = callsOf("detect_agents").length;
  toggle.click();
  await wait(100);
  const hiddenAgain = !visible(panel()) && toggle.getAttribute("aria-pressed") === "false";
  toggle.click();
  await waitFor(() => visible(panel()), 3000);
  await wait(150);
  check(
    "A02",
    "버튼을 누르면 패널이 보이고 `aria-pressed` true, `detect_agents` 1번. 닫았다 열어도 추가 호출 없음",
    afterOpen === 1 && hiddenAgain && toggle.getAttribute("aria-pressed") === "true" && callsOf("detect_agents").length === 1,
    `afterOpen=${afterOpen} total=${callsOf("detect_agents").length} hiddenAgain=${hiddenAgain}`,
  );

  // A03 — 못 찾은 프리셋은 비활성, 선택된 값은 찾은 것이다.
  const select = part("preset") as HTMLSelectElement | null;
  const opts = [...(select?.options ?? [])];
  const byId = (id: string) => opts.find((o) => o.value === id);
  const okSome =
    !!select &&
    opts.length === 3 &&
    byId("claude")?.disabled === false &&
    byId("codex")?.disabled === false &&
    byId("opencode")?.disabled === true &&
    select.value === "claude";
  // 하나도 못 찾는 창(iframe)에서는 보내기가 막히고 안내가 보인다.
  const frame = document.createElement("iframe");
  frame.style.cssText = "position:fixed;left:-2000px;top:0;width:1100px;height:700px";
  frame.src = `${location.pathname}?files=1&none=1`;
  document.body.append(frame);
  const child = await waitFor(() => {
    const d = frame.contentDocument;
    return d && d.querySelector(".pane") && d.querySelector("[data-agent-toggle]") ? frame.contentWindow : null;
  }, 15000);
  let noneOk = false;
  let noneDetail = "자식 창이 뜨지 않음";
  if (child) {
    await wait(300);
    child.document.querySelector<HTMLElement>("[data-agent-toggle]")!.click();
    await waitFor(() => child.document.querySelector("[data-agent-panel]") && visible(child.document.querySelector("[data-agent-panel]")), 8000);
    await wait(500);
    const cp = child.document.querySelector("[data-agent-prompt]") as HTMLTextAreaElement | null;
    if (cp) {
      cp.value = "무언가 해줘";
      cp.dispatchEvent(new Event("input", { bubbles: true }));
    }
    await wait(100);
    const cs = child.document.querySelector("[data-agent-send]") as HTMLButtonElement | null;
    const hint = child.document.querySelector("[data-agent-empty]");
    noneOk = !!cs && cs.disabled && !!hint && visible(hint) && (hint.textContent ?? "").trim().length > 0;
    noneDetail = `send=${!!cs} disabled=${cs?.disabled} hint=${!!hint}`;
  }
  frame.remove();
  check("A03", "찾은 프리셋만 고를 수 있고 못 찾은 것은 비활성. 하나도 못 찾으면 보내기 비활성 + 안내", okSome && noneOk, `some=${okSome} none=${noneOk} (${noneDetail})`);

  // A04
  const sendBlankOk: boolean[] = [];
  for (const v of ["", "   \n "]) {
    setPrompt(v);
    await wait(30);
    sendBlankOk.push(!enabled("send"));
  }
  setPrompt("문서를 다듬어 줘");
  await wait(30);
  check("A04", "지시문이 비었거나 공백뿐이면 보내기 비활성, 글자가 있으면 활성", sendBlankOk.every(Boolean) && enabled("send"), `blank=${JSON.stringify(sendBlankOk)} withText=${enabled("send")}`);

  // A05
  const run1 = await startRun("문서를 다듬어 줘");
  const a5 = callsOf("run_agent");
  check(
    "A05",
    "보내기 → `run_agent` 1번 `{preset, prompt, text, path}`, 실행 중 보내기 비활성 + 취소 보임",
    !!run1 &&
      a5.length === 1 &&
      run1.args.preset === "claude" &&
      run1.args.prompt === "문서를 다듬어 줘" &&
      run1.args.text === baseText &&
      run1.args.path === t1.path &&
      !enabled("send") &&
      enabled("cancel"),
    `calls=${a5.length} args=${JSON.stringify(run1?.args)} send=${enabled("send")} cancel=${enabled("cancel")}`,
  );
  if (!run1) return;

  // A06 + A15 — 로그는 경로별, 실행 상태도 탭별이다.
  emitTauri("agent-log", { path: t1.path, stream: "out", line: "첫째 탭 작업 줄" });
  await wait(100);
  const log1 = text(part("log"));
  activate(second!.path);
  await wait(150);
  const log2Empty = !text(part("log")).includes("첫째 탭 작업 줄");
  emitTauri("agent-log", { path: second!.path, stream: "err", line: "둘째 탭 경고 줄" });
  await wait(100);
  const log2 = text(part("log"));
  activate(t1.path);
  await wait(150);
  const log1Again = text(part("log"));
  check(
    "A06",
    "`agent-log` 줄이 그 경로 탭의 로그에만 쌓이고 다른 탭 로그에는 보이지 않는다",
    log1.includes("첫째 탭 작업 줄") && log2Empty && log2.includes("둘째 탭 경고 줄") && !log2.includes("첫째") && log1Again.includes("첫째 탭 작업 줄") && !log1Again.includes("둘째"),
    `log1=${JSON.stringify(log1)} log2Empty=${log2Empty} log2=${JSON.stringify(log2)} log1Again=${JSON.stringify(log1Again)}`,
  );

  activate(second!.path);
  await wait(150);
  const otherEnabled = (setPrompt("둘째 탭 지시"), await wait(30), enabled("send"));
  const run2 = await startRun("둘째 탭 지시");
  const twoRuns = callsOf("run_agent").length === 2 && run2?.args.path === second!.path;
  activate(t1.path);
  await wait(150);
  const stillRunning = !enabled("send") && enabled("cancel");
  check("A15", "한 탭이 실행 중이어도 다른 탭의 보내기는 활성이고 독립으로 실행되며, 돌아오면 실행 상태가 남아 있다", otherEnabled && twoRuns && stillRunning, `otherEnabled=${otherEnabled} twoRuns=${twoRuns} stillRunning=${stillRunning}`);

  // A07 — 취소
  const cancelBase = callsOf("cancel_agent").length;
  (part("cancel") as HTMLElement).click();
  await wait(100);
  const cancelCalls = callsOf("cancel_agent").slice(cancelBase);
  run1.reject("취소했습니다");
  await waitFor(() => enabled("send"), 3000);
  await wait(100);
  check(
    "A07",
    "취소 → `cancel_agent` 1번 `{path}`, '취소했습니다'로 끝나면 오류 표시 없이 보내기 다시 활성",
    cancelCalls.length === 1 && (cancelCalls[0].args as { path?: string }).path === t1.path && enabled("send") && !shown("error"),
    `cancels=${JSON.stringify(cancelCalls.map((c) => c.args))} send=${enabled("send")} error=${shown("error")}`,
  );

  // A08 — 오류
  const dirtyBefore = t1.dirty;
  const run3 = await startRun("실패할 지시");
  run3?.reject("에이전트가 오류로 끝났습니다(exit status: 1)");
  await waitFor(() => shown("error"), 3000);
  check(
    "A08",
    "오류로 끝나면 패널에 오류 글자, 보내기 다시 활성, 원문과 수정됨은 그대로",
    shown("error") && text(part("error")).includes("오류로 끝났습니다") && enabled("send") && t1.source === baseText && t1.dirty === dirtyBefore,
    `error=${text(part("error"))} send=${enabled("send")} source=${t1.source === baseText} dirty=${t1.dirty}`,
  );

  // A09 / A12 — diff 보기와 거절
  const result1 = `${baseText}추가된 줄\n`;
  const run4 = await startRun("한 줄 덧붙여 줘");
  run4?.resolve(result1);
  await waitFor(() => shown("diff"), 3000);
  const diff = part("diff");
  const hasAdd = !!diff?.querySelector('[data-line="add"]') && text(diff.querySelector('[data-line="add"]')).includes("추가된 줄");
  check(
    "A09",
    "실행이 끝나면 diff에 추가 줄이 보이고 수락·거절이 있으며 원문은 아직 그대로다",
    shown("diff") && hasAdd && enabled("accept") && enabled("reject") && t1.source === baseText && t1.dirty === dirtyBefore,
    `diff=${shown("diff")} add=${hasAdd} accept=${enabled("accept")} reject=${enabled("reject")} source=${t1.source === baseText}`,
  );
  (part("reject") as HTMLElement).click();
  await wait(100);
  check(
    "A12",
    "거절하면 원문과 수정됨은 그대로이고 diff가 사라진다",
    !shown("diff") && t1.source === baseText && t1.dirty === dirtyBefore && enabled("send"),
    `diff=${shown("diff")} source=${t1.source === baseText} dirty=${t1.dirty}`,
  );

  // A10 — 분할 모드 수락
  clickMode("split");
  await wait(200);
  const run5 = await startRun("한 줄 덧붙여 줘");
  run5?.resolve(result1);
  await waitFor(() => enabled("accept"), 3000);
  (part("accept") as HTMLElement).click();
  await waitFor(() => t1.source === result1, 3000);
  await wait(150);
  check(
    "A10",
    "분할 모드에서 수락하면 원문과 CodeMirror 문서가 결과와 같아지고 수정됨이 켜지며 diff가 사라진다",
    t1.source === result1 && cmContent(t1) === result1 && t1.dirty && !shown("diff"),
    `source=${JSON.stringify(t1.source)} cm=${JSON.stringify(cmContent(t1))} dirty=${t1.dirty} diff=${shown("diff")}`,
  );

  // A11 — 편집 모드(Muya) 수락
  activate(second!.path);
  await wait(150);
  // 이 탭의 실행(run2)은 아직 끝나지 않았다 — 먼저 마무리한다.
  run2?.reject("취소했습니다");
  await waitFor(() => enabled("send"), 3000);
  clickMode("edit");
  const muya = await muyaOf(second);
  const secondBase = second!.source;
  const result2 = `${secondBase}추가된 문단\n`;
  const run6 = await startRun("문단 하나 덧붙여 줘");
  run6?.resolve(result2);
  await waitFor(() => enabled("accept"), 3000);
  (part("accept") as HTMLElement).click();
  await waitFor(() => second!.source === result2, 3000);
  await wait(300);
  const md = (muya as unknown as { getMarkdown(): string } | null)?.getMarkdown() ?? "";
  check(
    "A11",
    "편집 모드(Muya)에서 수락하면 원문과 Muya 마크다운이 결과와 같아지고 수정됨이 켜진다",
    second!.source === result2 && md.trimEnd() === result2.trimEnd() && second!.dirty,
    `source=${JSON.stringify(second!.source)} muya=${JSON.stringify(md)} dirty=${second!.dirty}`,
  );

  // A13 — 실행 중 문서가 바뀌면 수락할 수 없다.
  activate(t1.path);
  await wait(150);
  clickMode("split");
  await wait(150);
  const run7 = await startRun("또 덧붙여 줘");
  const view = EditorView.findFromDOM(t1.editorHost)!;
  view.dispatch({ changes: { from: view.state.doc.length, insert: "사용자가 고친 줄\n" } });
  await wait(100);
  run7?.resolve(`${result1}에이전트 줄\n`);
  await waitFor(() => shown("stale") || shown("diff"), 3000);
  await wait(150);
  const rerunBase = callsOf("run_agent").length;
  const staleOk = shown("stale") && !enabled("accept") && enabled("discard") && enabled("rerun");
  const sourceNow = t1.source;
  (part("rerun") as HTMLElement).click();
  await wait(150);
  const rerun = callsOf("run_agent").slice(rerunBase);
  check(
    "A13",
    "실행 중 문서를 고치면 수락 비활성 + '바뀌었습니다' 안내 + 버리기·다시 실행. 다시 실행은 그 시점의 원문으로 부른다",
    staleOk && rerun.length === 1 && (rerun[0].args as { text?: string }).text === sourceNow && sourceNow.includes("사용자가 고친 줄"),
    `stale=${shown("stale")} accept=${enabled("accept")} discard=${enabled("discard")} rerun=${enabled("rerun")} rerunCalls=${rerun.length}`,
  );
  runs[runs.length - 1]?.reject("취소했습니다");
  await waitFor(() => enabled("send"), 3000);

  // A14 — 변경 없음
  const run8 = await startRun("그대로 둬");
  run8?.resolve(t1.source);
  await waitFor(() => shown("nochange"), 3000);
  check("A14", "결과가 보낸 원문과 같으면 '변경 없음' 안내가 보이고 수락은 비활성이다", shown("nochange") && !enabled("accept"), `nochange=${shown("nochange")} accept=${enabled("accept")}`);
  (part("discard") as HTMLElement | null)?.click();
  await wait(100);

  // A17 — 실행 중인 탭을 닫으면 취소한다.
  const third = await openTab("/tmp/harness-3.md");
  await waitFor(() => third && third.source.length > 0, 5000);
  activate(third!.path);
  await wait(150);
  const run9 = await startRun("닫을 탭의 지시");
  const cancelBase17 = callsOf("cancel_agent").length;
  (third!.button.querySelector(".tab-close") as HTMLElement | null)?.click();
  await wait(300);
  const closeCancels = callsOf("cancel_agent").slice(cancelBase17);
  check(
    "A17",
    "실행 중인 탭을 닫으면 `cancel_agent`가 그 경로로 1번 불린다",
    !!run9 && closeCancels.length === 1 && (closeCancels[0].args as { path?: string }).path === third!.path,
    `cancels=${JSON.stringify(closeCancels.map((c) => c.args))}`,
  );
  run9?.reject("취소했습니다");

  // A16 — 어느 단계에서도 저장하지 않았다.
  check("A16", "실행·수락·거절 어느 단계에서도 `write_markdown`이 불리지 않는다", callsOf("write_markdown").length === 0, `writes=${callsOf("write_markdown").length}`);
}

void guard(main);

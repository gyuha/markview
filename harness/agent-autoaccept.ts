// 에이전트 패널의 자동 수락 — 켜 두면 결과가 올 때 diff 검토 없이 문서에 반영한다(저장은 하지 않는다).
// 판정할 ID는 harness/required-agent.txt(R01~R05). 계약: `[data-agent-autoaccept]`(checkbox) · 저장소 키 `markview.agent.autoaccept`
//   · 출력 상자의 `[data-kind=status]` 줄 "자동으로 수락" · 나머지는 agent-core.ts와 같다.
import { EditorView } from "@codemirror/view";
import { calls, check, clickMode, guard, muyaOf, ready, respond, tabs, visible, wait, waitFor } from "./lib-muya";

const KEY = "markview.agent.autoaccept";
const params = new URLSearchParams(location.search);

type Run = { args: Record<string, unknown>; resolve: (text: string) => void; reject: (msg: string) => void };
const runs: Run[] = [];

const $ = (sel: string, root: ParentNode = document) => root.querySelector<HTMLElement>(sel);
const part = (name: string) => $(`[data-agent-${name}]`);
const shown = (name: string) => visible(part(name));
const text = (el: Element | null | undefined) => (el?.textContent ?? "").trim();
const callsOf = (cmd: string) => calls().filter((c) => c.cmd === cmd);
const auto = () => part("autoaccept") as HTMLInputElement;

function setAuto(on: boolean): void {
  if (auto().checked !== on) auto().click();
}

async function startRun(prompt: string): Promise<Run | null> {
  const before = runs.length;
  const el = part("prompt") as HTMLTextAreaElement;
  el.value = prompt;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  (part("send") as HTMLElement).click();
  return waitFor(() => (runs.length > before ? runs[runs.length - 1] : null), 3000);
}

async function main(): Promise<void> {
  if (params.has("child")) {
    // 새 창: 같은 저장소의 값을 읽어 패널을 열기만 한다. 검사는 부모가 한다.
    return;
  }
  localStorage.removeItem(KEY);
  await ready();
  respond("detect_agents", () => [{ id: "claude", name: "Claude Code", path: "/x/claude" }]);
  respond("run_agent", (args) => new Promise<string>((resolve, reject) => runs.push({ args: args ?? {}, resolve, reject: (m) => reject(m) })));
  respond("cancel_agent", () => null);
  const [tab] = tabs();
  const base = tab.source;

  $("#toolbar-right [data-agent-toggle]")!.click();
  await waitFor(() => visible(part("prompt")), 5000);
  await wait(300);

  // R01 — 기본 꺼짐, 켜면 저장, 새 창에서도 켜짐
  const defaultOff = !!part("autoaccept") && auto().checked === false && localStorage.getItem(KEY) !== "true";
  setAuto(true);
  await wait(100);
  const stored = localStorage.getItem(KEY) === "true";
  const frame = document.createElement("iframe");
  frame.style.cssText = "position:fixed;left:-2000px;top:0;width:1100px;height:700px";
  frame.src = `${location.pathname}?files=1&child=1`;
  document.body.append(frame);
  const child = await waitFor(() => {
    const d = frame.contentDocument;
    return d && d.querySelector(".pane") && d.querySelector("[data-agent-toggle]") ? frame.contentWindow : null;
  }, 15000);
  let childOn = false;
  if (child) {
    await wait(300);
    child.document.querySelector<HTMLElement>("[data-agent-toggle]")!.click();
    await waitFor(() => child.document.querySelector("[data-agent-autoaccept]"), 5000);
    childOn = (child.document.querySelector("[data-agent-autoaccept]") as HTMLInputElement | null)?.checked === true;
  }
  frame.remove();
  check("R01", "자동 수락 체크박스는 처음엔 꺼져 있고 켜면 저장되며 새 창에서도 켜진 채로 보인다", defaultOff && stored && childOn, `defaultOff=${defaultOff} stored=${stored} newWindow=${childOn}`);

  // R02 — 켜 둔 채: 바로 반영
  const result = `${base}추가된 줄\n`;
  const dirtyBefore = tab.dirty;
  const run1 = await startRun("한 줄 덧붙여 줘");
  run1?.resolve(result);
  await waitFor(() => tab.source === result, 3000);
  await wait(250);
  const note = [...document.querySelectorAll("[data-agent-log] > [data-kind=status]")].some((e) => text(e).includes("자동으로 수락"));
  check(
    "R02",
    "켜 둔 채 결과가 오면 수락을 누르지 않아도 원문이 결과와 같아지고 수정됨이 켜지며 diff·수락 단추는 없고 '자동으로 수락' 줄이 남으며 저장하지 않는다",
    tab.source === result && tab.dirty && dirtyBefore === false && !shown("diff") && !shown("accept") && note && callsOf("write_markdown").length === 0,
    `source=${tab.source === result} dirty=${tab.dirty} diff=${shown("diff")} accept=${shown("accept")} note=${note} writes=${callsOf("write_markdown").length}`,
  );

  // R03 — 꺼 둔 채: 지금처럼 검토
  setAuto(false);
  await wait(100);
  const sourceNow = tab.source;
  const run2 = await startRun("또 한 줄");
  run2?.resolve(`${sourceNow}검토할 줄\n`);
  await waitFor(() => shown("accept"), 3000);
  check(
    "R03",
    "꺼 둔 채 결과가 오면 diff와 수락·거절이 나오고 원문은 그대로다",
    shown("diff") && shown("accept") && shown("reject") && tab.source === sourceNow && stored === true,
    `diff=${shown("diff")} accept=${shown("accept")} source=${tab.source === sourceNow}`,
  );
  (part("reject") as HTMLElement).click();
  await wait(100);

  // R04 — 켜 둬도 충돌이면 자동 수락하지 않는다. 변경 없음도 안내만.
  setAuto(true);
  clickMode("split");
  await wait(250);
  const run3 = await startRun("또 덧붙여 줘");
  const view = EditorView.findFromDOM(tab.editorHost)!;
  view.dispatch({ changes: { from: view.state.doc.length, insert: "사용자가 고친 줄\n" } });
  await wait(100);
  const edited = tab.source;
  run3?.resolve(`${sourceNow}에이전트 줄\n`);
  await waitFor(() => shown("stale"), 3000);
  const conflictOk = shown("stale") && !!part("discard") && shown("discard") && shown("rerun") && tab.source === edited;
  (part("discard") as HTMLElement).click();
  await wait(100);
  const dirtyBeforeSame = tab.dirty;
  const run4 = await startRun("그대로 둬");
  run4?.resolve(tab.source);
  await waitFor(() => shown("nochange"), 3000);
  const noChangeOk = shown("nochange") && !shown("accept") && tab.dirty === dirtyBeforeSame;
  (part("discard") as HTMLElement).click();
  await wait(100);
  check("R04", "켜 둬도 실행 중 문서가 바뀌었으면 자동 수락하지 않고 안내가 나오며, 변경 없음이면 안내만 나온다", conflictOk && noChangeOk, `conflict=${conflictOk} noChange=${noChangeOk}`);

  // R05 — 편집 모드(Muya)
  clickMode("edit");
  const muya = await muyaOf(tab);
  await wait(300);
  const before5 = tab.source;
  const result5 = `${before5}편집 모드에서 온 문단\n`;
  const run5 = await startRun("문단 하나");
  run5?.resolve(result5);
  await waitFor(() => tab.source === result5, 3000);
  await wait(300);
  const md = (muya as unknown as { getMarkdown(): string } | null)?.getMarkdown() ?? "";
  check("R05", "편집 모드(Muya)에서도 자동 수락이 원문과 Muya 마크다운을 결과로 바꾼다", tab.source === result5 && md.includes("편집 모드에서 온 문단"), `source=${tab.source === result5} muya=${JSON.stringify(md.slice(-40))}`);

  localStorage.removeItem(KEY);
}

void guard(main);

// AI 에이전트 패널의 선택 영역과 내장 빠른 액션 — 실제 DOM 이벤트로 구동하고 DOM·모킹 IPC 호출 기록으로만 판정한다.
// 판정할 ID는 harness/required-agent.txt(A18~A24). 계약은 agent-core.ts 머리말에 더해:
//   `[data-agent-selection]`(미리보기) · `[data-agent-selection-clear]` · `[data-agent-chip]`(4개).
// 선택은 사용자가 패널을 누르는 순간(포인터 누름) 편집기에서 읽는다 — 편집기 선택이 패널로 포커스가 옮겨 가며 사라지기 전이다.
import { EditorView } from "@codemirror/view";
import { calls, check, clickMode, guard, injectViaSplit, muyaOf, ready, respond, selectText, tabs, visible, wait, waitFor } from "./lib-muya";

type Run = { args: Record<string, unknown>; resolve: (text: string) => void; reject: (msg: string) => void };
const runs: Run[] = [];

const $ = (sel: string) => document.querySelector<HTMLElement>(sel);
const part = (name: string) => $(`[data-agent-${name}]`);
const shown = (name: string) => visible(part(name));
const text = (el: Element | null | undefined) => (el?.textContent ?? "").trim();
const callsOf = (cmd: string) => calls().filter((c) => c.cmd === cmd);
const sendEnabled = () => {
  const b = part("send") as HTMLButtonElement | null;
  return !!b && !b.disabled && visible(b);
};

function setPrompt(value: string): void {
  const el = part("prompt") as HTMLTextAreaElement;
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/** 사용자가 편집기에서 글자를 고른 뒤 패널을 누르는 순간을 만든다. */
async function pressPanel(): Promise<void> {
  // 사용자는 편집기에서 고른 뒤 패널을 누른다 — 포커스가 패널 안에 남아 있으면 편집기에 있던 것으로 되돌린다.
  const active = document.activeElement as HTMLElement | null;
  if (active && part("prompt")!.closest("[data-agent-panel]")!.contains(active)) active.blur();
  part("prompt")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
  await wait(120);
}

async function startRun(prompt: string): Promise<Run | null> {
  const before = runs.length;
  setPrompt(prompt);
  (part("send") as HTMLElement).click();
  return waitFor(() => (runs.length > before ? runs[runs.length - 1] : null), 3000);
}

async function main(): Promise<void> {
  await ready();
  respond("detect_agents", () => [{ id: "claude", name: "Claude Code", path: "/x/claude" }]);
  respond("run_agent", (args) => new Promise<string>((resolve, reject) => runs.push({ args: args ?? {}, resolve, reject: (m) => reject(m) })));
  respond("cancel_agent", () => null);
  const [tab] = tabs();

  $("#toolbar-right [data-agent-toggle]")!.click();
  await waitFor(() => visible(part("prompt")), 5000);
  await wait(300);

  // A22
  const chips = [...document.querySelectorAll<HTMLElement>("[data-agent-chip]")];
  check("A22", "빠른 액션 칩이 4개 보이고 각각 이름이 있다", chips.length === 4 && chips.every((c) => visible(c) && text(c).length > 0), `chips=${JSON.stringify(chips.map(text))}`);

  // A23 — 누르면 입력창을 채우고 보내지는 않는다. 이름에 든 낱말이 문장에도 든다.
  const keywords = ["번역", "요약", "맞춤법", "목차"];
  const filled: string[] = [];
  let fillOk = chips.length === 4;
  for (const chip of chips) {
    setPrompt("");
    chip.click();
    await wait(60);
    const value = (part("prompt") as HTMLTextAreaElement).value;
    filled.push(value);
    const key = keywords.find((k) => text(chip).includes(k));
    fillOk = fillOk && !!key && value.includes(key) && value.trim().length > 10;
  }
  check("A23", "칩을 누르면 지시 입력창이 그 칩의 문장으로 채워지고 보내기가 활성이며 `run_agent`는 불리지 않는다", fillOk && sendEnabled() && callsOf("run_agent").length === 0, `filled=${JSON.stringify(filled)} send=${sendEnabled()} runs=${callsOf("run_agent").length}`);
  setPrompt("");

  // A18 — 분할 모드(CodeMirror)
  clickMode("split");
  await wait(250);
  const view = EditorView.findFromDOM(tab.editorHost)!;
  const doc = view.state.doc.toString();
  const from = doc.indexOf("본문");
  view.dispatch({ selection: { anchor: from, head: from + 2 } });
  await pressPanel();
  const cmShown = shown("selection") && text(part("selection")).includes("본문");
  view.dispatch({ selection: { anchor: 0 } });
  await pressPanel();
  const cmGone = !shown("selection");
  // 선택이 있는 채로 A20/A21에 쓴다.
  view.dispatch({ selection: { anchor: from, head: from + 2 } });
  await pressPanel();
  check("A18", "분할 모드에서 글자를 고르고 패널을 누르면 미리보기에 그 글자가 보이고, 선택이 없으면 보이지 않는다", cmShown && cmGone, `shown=${cmShown} gone=${cmGone}`);

  // A20 — 선택이 있을 때와 없을 때의 prompt
  const withSel = await startRun("간결하게 해 줘");
  const promptWith = String(withSel?.args.prompt ?? "");
  withSel?.reject("취소했습니다");
  await waitFor(() => sendEnabled() || (part("prompt") as HTMLTextAreaElement).value.length > 0, 2000);
  await wait(100);

  // A21 — 선택 해제 뒤의 prompt
  const clearBtn = part("selection-clear") as HTMLElement | null;
  const hadPreview = shown("selection") && !!clearBtn;
  clearBtn?.click();
  await wait(100);
  const cleared = hadPreview && !shown("selection");
  const noSel = await startRun("간결하게 해 줘");
  const promptWithout = String(noSel?.args.prompt ?? "");
  noSel?.reject("취소했습니다");
  await wait(100);
  check(
    "A20",
    "선택이 있으면 `prompt`가 `<선택>`…`</선택>`으로 선택 원문을 담고 그 뒤에 사용자 지시가 오며, 없으면 사용자 지시 그대로다",
    promptWith.includes("<선택>\n본문\n</선택>") && promptWith.trimEnd().endsWith("간결하게 해 줘") && promptWith.indexOf("</선택>") < promptWith.indexOf("간결하게 해 줘") && promptWithout === "간결하게 해 줘",
    `with=${JSON.stringify(promptWith)} without=${JSON.stringify(promptWithout)}`,
  );
  check("A21", "선택 해제를 누르면 미리보기가 사라지고 다음 실행의 `prompt`가 사용자 지시 그대로다", cleared && promptWithout === "간결하게 해 줘", `cleared=${cleared} without=${JSON.stringify(promptWithout)}`);

  // A24 — 실행 중에는 칩이 비활성
  const running = await startRun("오래 걸리는 지시");
  const chipEls = () => [...document.querySelectorAll<HTMLButtonElement>("[data-agent-chip]")];
  const chipsDisabled = chipEls().length === 4 && chipEls().every((c) => c.disabled);
  running?.reject("취소했습니다");
  await waitFor(() => sendEnabled() || !!part("prompt"), 2000);
  await wait(100);
  const chipsBack = chipEls().length === 4 && chipEls().every((c) => !c.disabled);
  check("A24", "실행 중에는 칩이 모두 비활성이다(끝나면 다시 활성)", running !== null && chipsDisabled && chipsBack, `during=${chipsDisabled} after=${chipsBack}`);

  // A19 — 편집 모드(Muya): 선택한 마크다운 원문 그대로
  injectViaSplit("alpha **beta** gamma\n");
  clickMode("edit");
  await muyaOf(tab);
  await wait(300);
  const content = tab.muyaHost.querySelector(".mu-content");
  let muyaShown = false;
  let muyaGone = false;
  let muyaDetail = "mu-content 없음";
  if (content) {
    (document.activeElement as HTMLElement | null)?.blur();
    (content as HTMLElement).focus();
    await selectText(content, "beta");
    await pressPanel();
    const shownText = text(part("selection"));
    muyaShown = shown("selection") && shownText.includes("beta");
    getSelection()?.removeAllRanges();
    content.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowLeft", bubbles: true }));
    await pressPanel();
    muyaGone = !shown("selection");
    muyaDetail = `shown=${muyaShown}(${JSON.stringify(shownText)}) gone=${muyaGone}`;
  }
  check("A19", "편집 모드(Muya)에서도 글자를 고르고 패널을 누르면 미리보기에 선택 원문이 보이고, 선택이 없으면 보이지 않는다", muyaShown && muyaGone, muyaDetail);
}

void guard(main);

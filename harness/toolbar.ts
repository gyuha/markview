// 3모드 전환과 서식 버튼 비활성 검증. 실제 index.html 마크업 + 실제 main.ts를 쓴다 —
// `node harness/build-mocked.mjs toolbar` 로 페이지를 만들고 브라우저에서 #out 을 읽는다.
import { EditorView } from "@codemirror/view";

const out = document.querySelector<HTMLElement>("#out")!;
const lines: string[] = [];

function snap(label: string): void {
  const pane = document.querySelector<HTMLElement>(".pane:not([hidden])");
  // 존재 판정을 `el.hidden`(속성)이 아니라 computed display로 한다 —
  // 속성은 true인데 display가 남는 버그(.pane 겹침)에 속성 판정은 눈이 멀어 있다.
  const visible = (el: HTMLElement | null | undefined) =>
    !!el && getComputedStyle(el).display !== "none";
  const editor = pane?.querySelector<HTMLElement>(".editor-host") ?? null;
  const preview = pane?.querySelector<HTMLElement>(".preview") ?? null;
  const checked = [...document.querySelectorAll<HTMLElement>("#view-mode [data-mode]")]
    .filter((b) => b.getAttribute("aria-checked") === "true")
    .map((b) => b.dataset.mode);
  const fmts = [...document.querySelectorAll<HTMLButtonElement>("#format [data-format]")];
  lines.push(
    `${label}: 에디터=${visible(editor) ? "있음" : "없음"} 프리뷰=${
      visible(preview) ? "있음" : "없음"
    } 선택=${JSON.stringify(checked)} 비활성=${fmts.filter((b) => b.disabled).length}/${fmts.length}`,
  );
}

function click(mode: string): void {
  document.querySelector<HTMLElement>(`#view-mode [data-mode="${mode}"]`)!.click();
}

/** 수정자 없는 keydown. 편집기가 있으면 그 안에서 쏘아 CM6를 통과해 window까지 오는지 함께 본다. */
function press(key: string): void {
  const target =
    document.querySelector<HTMLElement>(".pane:not([hidden]) .cm-content") ?? document.body;
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

const started = Date.now();
const timer = window.setInterval(() => {
  if (!document.querySelector(".pane")) {
    if (Date.now() - started > 5000) {
      out.textContent = "탭이 열리지 않음 (모킹 실패)";
      window.clearInterval(timer);
    }
    return;
  }
  window.clearInterval(timer);

  lines.push(`탭수=${document.querySelectorAll(".tab").length}`);
  snap("초기(보기)");
  click("edit");
  snap("편집");
  click("split");
  snap("분할");
  click("view");
  snap("보기");

  // 버튼 클릭이 실제 편집기에 반영되는지 (installFormatControl 배선)
  click("split");
  const view = EditorView.findFromDOM(document.querySelector<HTMLElement>(".editor-host")!);
  if (!view) {
    lines.push("편집기 핸들을 찾지 못함");
  } else {
    view.dispatch({ selection: { anchor: 0, head: 2 } });
    document.querySelector<HTMLElement>('#format [data-format="bold"]')!.click();
    lines.push(`버튼 굵게 → ${JSON.stringify(view.state.doc.toString())}`);
  }

  // F키 단축키. press가 편집기 안에서 쏘므로 CM6를 통과해 window까지 오는지도 함께 본다.
  press("F1");
  snap("F1(편집)");
  press("F2");
  snap("F2(분할)");
  press("F3");
  snap("F3(보기)");

  // 모달이 떠 있으면 전역 단축키가 통째로 막혀야 한다 — 모드 전환이 모달의 포커스를 훔치지 않도록.
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  document.body.appendChild(backdrop);
  press("F1");
  snap("모달 중 F1(무효여야 함)");
  backdrop.remove();

  out.textContent = lines.join("\n");
}, 100);

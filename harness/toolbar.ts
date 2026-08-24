// 3모드 전환과 서식 버튼 비활성 검증. 실제 index.html 마크업 + 실제 main.ts를 쓴다 —
// `node harness/build-mocked.mjs toolbar` 로 페이지를 만들고 브라우저에서 #out 을 읽는다.
import { EditorView } from "@codemirror/view";

const out = document.querySelector<HTMLElement>("#out")!;
const lines: string[] = [];

function snap(label: string): void {
  const pane = document.querySelector<HTMLElement>(".pane:not([hidden])");
  const editor = pane?.querySelector<HTMLElement>(".editor-host") ?? null;
  const preview = pane?.querySelector<HTMLElement>(".preview") ?? null;
  const checked = [...document.querySelectorAll<HTMLElement>("#view-mode [data-mode]")]
    .filter((b) => b.getAttribute("aria-checked") === "true")
    .map((b) => b.dataset.mode);
  const fmts = [...document.querySelectorAll<HTMLButtonElement>("#format [data-format]")];
  lines.push(
    `${label}: 에디터=${editor && !editor.hidden ? "있음" : "없음"} 프리뷰=${
      preview && !preview.hidden ? "있음" : "없음"
    } 선택=${JSON.stringify(checked)} 비활성=${fmts.filter((b) => b.disabled).length}/${fmts.length}`,
  );
}

function click(mode: string): void {
  document.querySelector<HTMLElement>(`#view-mode [data-mode="${mode}"]`)!.click();
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
  out.textContent = lines.join("\n");
}, 100);

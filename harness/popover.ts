import { EditorView } from "@codemirror/view";

const out = document.querySelector<HTMLElement>("#out")!;
const lines: string[] = [];
const q = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

function tree(): string {
  // "트리에 나타난다/사라진다"를 hidden 여부와 보이는 항목 수로 측정한다.
  const pops = [...document.querySelectorAll<HTMLElement>(".popover")];
  return pops
    .map((p) => `${p.dataset.popoverFor}=${p.hidden ? "닫힘" : `열림(${p.querySelectorAll("[data-format]").length}항목)`}`)
    .join(" ");
}
function expanded(): string {
  return [...document.querySelectorAll<HTMLElement>("[data-popover]")]
    .map((t) => `${t.dataset.popover}:${t.getAttribute("aria-expanded")}`)
    .join(" ");
}
function focusIsEditor(): boolean {
  return !!document.activeElement?.closest(".editor-host");
}

const started = Date.now();
const timer = window.setInterval(() => {
  if (!document.querySelector(".pane")) {
    if (Date.now() - started > 5000) { out.textContent = "탭이 열리지 않음"; window.clearInterval(timer); }
    return;
  }
  window.clearInterval(timer);
  q('#view-mode [data-mode="split"]').click();
  const view = EditorView.findFromDOM(q(".editor-host"))!;

  lines.push(`haspopup=${document.querySelectorAll("[aria-haspopup]").length}개`);
  lines.push(`초기: ${tree()} / ${expanded()}`);

  // 열기
  q('[data-popover="heading"]').click();
  lines.push(`헤딩 열기: ${tree()} / ${expanded()} / 포커스=${document.activeElement?.getAttribute("data-format")}`);

  // 항목 클릭 → 변환 + 닫힘 + 포커스 복귀
  q('.popover[data-popover-for="heading"] [data-format="h2"]').click();
  lines.push(`H2 클릭: doc=${JSON.stringify(view.state.doc.toString())} / ${tree()} / 포커스가 에디터=${focusIsEditor()}`);

  // 다시 열면 현재 레벨이 선택 상태로 표시되는지
  q('[data-popover="heading"]').click();
  const checked = [...document.querySelectorAll<HTMLElement>('.popover[data-popover-for="heading"] [data-format]')]
    .filter((b) => b.getAttribute("aria-checked") === "true")
    .map((b) => b.dataset.format);
  lines.push(`재개방 선택표시=${JSON.stringify(checked)}`);

  // Esc로 닫기
  q('.popover[data-popover-for="heading"]').dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
  );
  lines.push(`Esc: ${tree()} / 포커스가 에디터=${focusIsEditor()}`);

  // 화살표 이동
  q('[data-popover="heading"]').click();
  const pop = q('.popover[data-popover-for="heading"]');
  pop.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
  const after1 = document.activeElement?.getAttribute("data-format");
  pop.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
  lines.push(`↓ 후=${after1} ↑ 후=${document.activeElement?.getAttribute("data-format")}`);

  // 바깥 클릭으로 닫기
  document.querySelector<HTMLElement>("#tabbar")!.click();
  lines.push(`바깥 클릭: ${tree()} / 포커스가 에디터=${focusIsEditor()}`);

  // 코드 드롭다운
  q('[data-popover="code"]').click();
  lines.push(`코드 열기: ${tree()}`);
  q('.popover[data-popover-for="code"] [data-format="codeblock"]').click();
  lines.push(`코드블록 클릭: doc=${JSON.stringify(view.state.doc.toString())} / ${tree()}`);

  // 보기 모드로 가면 트리거도 잠기고 팝오버는 닫힌다
  q('[data-popover="code"]').click();
  q('#view-mode [data-mode="view"]').click();
  const locked = [...document.querySelectorAll<HTMLButtonElement>("[data-popover]")].filter((b) => b.disabled).length;
  lines.push(`보기 모드: 트리거 비활성=${locked}/2 ${tree()}`);

  out.textContent = lines.join("\n");
}, 100);

// 편집 전용 모드의 MarkText 플로팅 UI 플러그인(U01–U09). 조작은 DOM 이벤트·선택·execCommand로만 일으키고
// (엔진 편집 API·플러그인 메서드 호출 금지), 엔진은 판정(getMarkdown·DOM 조회)에만 쓴다.
// 문서는 /fixtures/doc.md 탭으로 열어 상대 경로 이미지 `logo.png`가 개발 서버에서 실제로 로드되게 하고,
// 검사마다 분할 모드 CodeMirror로 자기 픽스처를 새로 넣는다(서로 간섭하지 않게).
//
// 표시 여부는 속성이 아니라 computed style로 잰다(하네스 ADR). 플로팅 상자(vendor/muya/src/ui/baseFloat)는
// 숨길 때 opacity 0 + top/left -9999px, 보일 때 opacity 1 + 기준 요소 옆 좌표이므로
// "computed opacity가 1이고 상자가 화면 안에 있다"를 보임으로 본다. 동작 전에 숨어 있었는지도 함께 본다 —
// 앞 검사가 남긴 상자 때문에 통과하는 거짓 PASS를 막는다.
import {
  check,
  clickMode,
  guard,
  injectViaSplit,
  muyaOf,
  openTab,
  pressKey,
  ready,
  respond,
  visible,
  wait,
  waitFor,
} from "./lib-muya";
import type { MuyaEditor } from "../src/muya";

const DOC_PATH = "/fixtures/doc.md";

/** 플로팅 상자(컨테이너의 부모)가 화면에 보이면 그 사각형, 아니면 null. */
function shownBox(container: Element | null | undefined): DOMRect | null {
  const box = container?.parentElement;
  if (!box || !visible(box)) return null;
  const style = getComputedStyle(box);
  const rect = box.getBoundingClientRect();
  const onScreen =
    rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight;
  return style.opacity === "1" && style.visibility !== "hidden" && onScreen ? rect : null;
}

/** 선택자에 맞는 컨테이너 중 보이는 것. 같은 이름(mu-list-picker)을 쓰는 플러그인은 바깥 상자 클래스로 가른다. */
function shown(selector: string): HTMLElement | null {
  return [...document.querySelectorAll<HTMLElement>(selector)].find((c) => shownBox(c)) ?? null;
}

const SEL = {
  format: ".mu-float-container.mu-format-picker",
  quickInsert: ".mu-float-container.mu-quick-insert",
  // ParagraphFrontButton은 BaseFloat가 아니다 — .mu-front-button-wrapper > .mu-front-button.
  frontButton: ".mu-front-button-wrapper > .mu-front-button",
  frontMenu: ".mu-float-container.mu-front-menu",
  // CodeBlockLanguageSelector와 ImagePathPicker는 둘 다 이름이 mu-list-picker다.
  language: ".mu-float-wrapper:not(.mu-image-picker-wrapper) > .mu-float-container.mu-list-picker",
  imagePath: ".mu-image-picker-wrapper > .mu-float-container.mu-list-picker",
  emoji: ".mu-float-container.mu-emoji-picker",
  columnTools: ".mu-float-container.mu-table-column-tools",
  dragBar: ".mu-float-container.mu-table-drag-bar",
  rowColumnMenu: ".mu-float-container.mu-table-bar-tools",
  tablePicker: ".mu-float-container.mu-table-picker",
  imageToolbar: ".mu-float-container.mu-image-toolbar",
  imageEdit: ".mu-float-container.mu-image-selector",
  linkTools: ".mu-float-container.mu-link-tools",
  previewTools: ".mu-float-container.mu-preview-tools",
};

/** 화면 좌표 (x, y)에 마우스 이벤트를 보낸다. 대상은 그 점의 요소(실제 포인터와 같은 버블 경로). */
function mouseAt(type: string, x: number, y: number, target?: Element | null): void {
  (target ?? document.elementFromPoint(x, y) ?? document.body).dispatchEvent(
    new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, view: window }),
  );
}

/** 요소 한가운데를 누른다. */
function clickEl(el: Element): void {
  const r = el.getBoundingClientRect();
  el.dispatchEvent(
    new MouseEvent("click", { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true, view: window }),
  );
}

function setRange(startNode: Node, startOffset: number, endNode: Node = startNode, endOffset: number = startOffset): void {
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  getSelection()!.removeAllRanges();
  getSelection()!.addRange(range);
}

/** 요소 안에서 글자를 담은 첫 텍스트 노드. */
function textNodeWith(root: Element, text: string): Text | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.textContent?.includes(text)) return n as Text;
  return null;
}

async function type(text: string): Promise<void> {
  for (const ch of text) {
    document.execCommand("insertText", false, ch);
    await wait(30);
  }
  await wait(120);
}

/**
 * 떠 있는 상자를 모두 거둔다. 문서 click은 BaseFloat·이미지 크기 조절 바를 숨기고(baseFloat listen),
 * 빈 곳 mousemove는 마우스로 뜨는 상자(문단 핸들·표 도구·미리보기 툴바)를 숨긴다. 그 처리기는 300ms 스로틀이다.
 */
async function settle(): Promise<void> {
  mouseAt("mousemove", 1, 1, document.body);
  document.body.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  await wait(400);
}

/** 분할 모드로 픽스처를 넣고 편집 모드로 돌아와 Muya가 다시 그릴 때까지 기다린다. */
async function load(doc: string): Promise<void> {
  injectViaSplit(doc);
  clickMode("edit");
  await wait(250);
  await settle();
}

/** "시작" 문단 끝에서 Enter로 빈 문단을 만들고 캐럿을 둔다(muya-input과 같은 방법). */
async function emptyParagraphAfterStart(muya: MuyaEditor): Promise<void> {
  await load("시작\n");
  const content = muya.domNode.querySelector(".mu-paragraph .mu-content")!;
  const range = document.createRange();
  range.selectNodeContents(content);
  range.collapse(false);
  getSelection()!.removeAllRanges();
  getSelection()!.addRange(range);
  await wait(30);
  pressKey("Enter", {}, content);
  await wait(150);
}

const near = (a: number, b: number, tol = 2) => Math.abs(a - b) <= tol;

await guard(async () => {
  if (!(await ready())) return check("", "탭이 열렸다", false);
  const tab = await openTab(DOC_PATH);
  injectViaSplit("시작\n");
  clickMode("edit");
  const muya = await muyaOf(tab);
  if (!muya) return check("", "Muya가 만들어졌다", false);
  await wait(250);
  const root = muya.domNode;

  // ── U01 인라인 서식 툴바 ──────────────────────────────────────────────
  // 블록의 keyup/click 처리기가 DOM 선택이 접히지 않았을 때 muya-format-picker를 낸다(block/base/format.ts
  // clickHandler·keyupHandler). Shift+화살표로 고른 것과 같게 선택을 놓고 keyup을 보낸다.
  {
    await load("alpha beta gamma\n");
    const content = root.querySelector(".mu-paragraph .mu-content")!;
    const before = !!shown(SEL.format);
    const node = textNodeWith(content, "beta");
    if (node) {
      const i = node.textContent!.indexOf("beta");
      setRange(node, i, node, i + 4);
    }
    content.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowRight", shiftKey: true, bubbles: true }));
    const bar = await waitFor(() => shown(SEL.format), 3000);
    const bold = bar?.querySelector("li.item.strong");
    if (bold) clickEl(bold);
    await wait(200);
    const md = muya.getMarkdown();
    check(
      "U01",
      "텍스트를 선택하면 인라인 서식 툴바가 보이고, 굵게 버튼이 선택을 **…**로 만든다",
      !before && !!bar && !!bold && md === "alpha **beta** gamma\n",
      JSON.stringify({ before, bar: !!bar, bold: !!bold, md }),
    );
  }

  // ── U02 빠른 삽입 메뉴 ────────────────────────────────────────────────
  // 문단 글자가 /^[/、]\S*$/이면 content-change에서 메뉴가 뜬다(ui/paragraphQuickInsertMenu).
  {
    await emptyParagraphAfterStart(muya);
    const before = !!shown(SEL.quickInsert);
    await type("/");
    const menu = await waitFor(() => shown(SEL.quickInsert), 3000);
    const item = menu?.querySelector('.item[data-label="code-block"]');
    if (item) clickEl(item);
    await wait(250);
    const md = muya.getMarkdown();
    const blocks = root.querySelectorAll("pre.mu-code-block").length;
    // "/" 문단이 빈 펜스 코드블록으로 바뀐다 — 다른 블록은 그대로.
    check(
      "U02",
      "빈 문단에 \"/\" → 빠른 삽입 메뉴가 보이고, 코드블록 항목이 그 자리에 코드블록을 넣는다",
      !before && !!menu && !!item && blocks === 1 && /^시작\n\n```\n\n?```\n$/.test(md),
      JSON.stringify({ before, menu: !!menu, item: !!item, blocks, md }),
    );
  }

  // ── U03 문단 핸들(ParagraphFrontButton) → 문단 메뉴 → 복제 ──────────────
  // 핸들은 document mousemove에서 포인터(또는 오른쪽 100px) 아래의 최상위 블록에 붙는다. 누르면 muya-front-menu.
  {
    await load("첫 문단\n\n둘째 문단\n");
    const para = root.querySelectorAll(".mu-paragraph")[1];
    const before = !!shown(SEL.frontButton);
    const pr = para.getBoundingClientRect();
    mouseAt("mousemove", pr.left + 10, pr.top + pr.height / 2);
    const button = await waitFor(() => shown(SEL.frontButton), 3000);
    const br = shownBox(button);
    // 핸들은 그 문단의 왼쪽 바로 옆(left-start)에 선다.
    const besideParagraph = !!br && near(br.right, pr.left) && near(br.top, pr.top);
    const menuBefore = !!shown(SEL.frontMenu);
    if (button) clickEl(button);
    const menu = await waitFor(() => shown(SEL.frontMenu), 3000);
    const duplicate = menu?.querySelector("li.item.duplicate");
    if (duplicate) clickEl(duplicate);
    await wait(250);
    const md = muya.getMarkdown();
    check(
      "U03",
      "문단 왼쪽 핸들이 보이고, 누르면 문단 메뉴가 열리며 \"복제\"가 문단을 복제한다",
      !before && besideParagraph && !menuBefore && !!menu && !!duplicate && md === "첫 문단\n\n둘째 문단\n\n둘째 문단\n",
      JSON.stringify({ before, button: !!button, besideParagraph, menuBefore, menu: !!menu, duplicate: !!duplicate, md }),
    );
  }

  // ── U04 코드블록 언어 선택기 ───────────────────────────────────────────
  // 언어 입력(.mu-language-input) 글자가 바뀌면 content-change에서 Prism 언어 검색 결과로 뜬다.
  {
    await load("```js\nconst a = 1;\n```\n");
    const lang = root.querySelector("pre.mu-code-block .mu-language-input")!;
    const before = !!shown(SEL.language);
    const range = document.createRange();
    range.selectNodeContents(lang);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
    await wait(30);
    document.execCommand("insertText", false, "pyth");
    await wait(150);
    const picker = await waitFor(() => shown(SEL.language), 3000);
    const python = picker?.querySelector('li.item[data-label="python"]');
    if (python) clickEl(python);
    await wait(250);
    const md = muya.getMarkdown();
    check(
      "U04",
      "코드블록 언어 선택기가 열리고 python을 고르면 펜스가 ```js → ```python으로 바뀐다",
      !before && !!picker && !!python && md === "```python\nconst a = 1;\n```\n",
      JSON.stringify({ before, picker: !!picker, python: !!python, md }),
    );
  }

  // ── U05 이모지 선택기 ─────────────────────────────────────────────────
  // 엔진은 캐럿이 완성된 이모지 토큰 `:이름:` "안"에 있는 입력에서만 선택기를 띄운다 — 토큰 규칙이 닫는 콜론을
  // 요구하고(inlineRenderer/rules.ts `emoji: /^(:)([a-z_\d+-]+)\1/`), 띄우는 곳은 Format.inputHandler의
  // `offset < token.range.end` 검사뿐이다(block/base/format.ts). 콜론은 자동 짝 대상도 아니다. 그래서 닫는
  // 콜론 없이 빈 곳에 ":smi"만 치면 MarkText(구판 keyboard.js의 checkEditEmoji도 같다)에서도 뜨지 않는다.
  // 계약의 ":smi" 입력을 그대로 치되, 픽스처 문단 끝에 닫는 ":"를 두고 캐럿을 그 앞에 놓아 토큰 안에서 치게 한다.
  {
    await load("첫 줄\n\n감정 :\n");
    const content = root.querySelectorAll(".mu-paragraph .mu-content")[1];
    const before = !!shown(SEL.emoji);
    const node = textNodeWith(content, "감정");
    if (node) setRange(node, node.textContent!.length - 1);
    await wait(30);
    await type(":smi");
    const picker = await waitFor(() => shown(SEL.emoji), 3000);
    const smile = picker?.querySelector('.item[data-label="smile"]');
    if (smile) clickEl(smile);
    await wait(250);
    const md = muya.getMarkdown();
    const emoji = content.querySelector(".mu-emoji-marked-text")?.getAttribute("data-emoji") ?? null;
    check(
      "U05",
      "\":smi\" 입력 → 이모지 선택기가 보이고, smile을 고르면 :smile:(😄)이 들어간다",
      !before && !!picker && !!smile && md === "첫 줄\n\n감정 :smile:\n" && emoji === "😄",
      JSON.stringify({ before, picker: !!picker, smile: !!smile, md, emoji }),
    );
  }

  // ── U06 표 도구 ───────────────────────────────────────────────────────
  {
    // (가) TableChessboard — 빠른 삽입의 "표" 항목이 muya-table-picker를 낸다(block/blockTransforms.ts showTablePicker).
    await emptyParagraphAfterStart(muya);
    const pickerBefore = !!shown(SEL.tablePicker);
    await type("/");
    const menu = await waitFor(() => shown(SEL.quickInsert), 3000);
    const tableItem = menu?.querySelector('.item[data-label="table"]');
    if (tableItem) clickEl(tableItem);
    const picker = await waitFor(() => shown(SEL.tablePicker), 3000);
    // 격자는 6행 × 8열(ui/tableChessboard _checkerCount).
    const grid = picker?.querySelectorAll(".mu-table-picker-cell").length ?? 0;
    const chessboard = !pickerBefore && !!picker && grid === 48;

    // (나) 열 툴바 — 셀에 캐럿을 두고, 포인터를 그 열 바로 위로 옮긴다. 열 툴바는 포커스가 아니라
    // body mousemove에서 (x, y)에는 셀이 없고 (x, y+27)에 셀이 있을 때 뜬다(ui/tableColumnToolbar).
    await load("| a | b |\n| - | - |\n| 1 | 2 |\n");
    const cells = root.querySelectorAll("figure.mu-table td");
    const cell = cells[2]; // "1"
    const cellContent = cell?.querySelector(".mu-content") ?? cell;
    const columnBefore = !!shown(SEL.columnTools);
    if (cellContent) {
      const range = document.createRange();
      range.selectNodeContents(cellContent);
      range.collapse(false);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
      clickEl(cellContent);
    }
    await wait(200);
    // 표가 그려지지 않았으면 예외 대신 이 검사만 FAIL로 남긴다(뒤 검사가 돌게).
    const head = cells[0]?.getBoundingClientRect();
    if (head) mouseAt("mousemove", head.left + head.width / 2, head.top - 10);
    const columnTools = head ? await waitFor(() => shown(SEL.columnTools), 3000) : null;
    const cr = shownBox(columnTools);
    // 툴바는 그 열 위(top)에 붙는다 — 가로로 열과 겹치고 아래 끝이 첫 행 위쪽 근처다.
    const overColumn = !!cr && !!head && cr.left < head.right && cr.right > head.left && near(cr.bottom, head.top, 4);
    await wait(350);

    // (다) 드래그 바 — 행 오른쪽 바로 바깥(x-20에 셀)으로 가면 오른쪽 막대가 뜬다(ui/tableDragBar).
    const rowRect = cell?.closest("tr")?.getBoundingClientRect();
    const dragBefore = !!shown(SEL.dragBar);
    if (rowRect) mouseAt("mousemove", rowRect.right + 8, rowRect.top + rowRect.height / 2);
    const dragBar = rowRect ? await waitFor(() => shown(SEL.dragBar), 3000) : null;
    const dragSide = dragBar?.dataset.drag ?? null;

    // (라) 행/열 메뉴 — 드래그 바를 짧게 누르면(300ms 안에 mouseup) muya-table-bar로 메뉴가 열린다.
    const menuBefore = !!shown(SEL.rowColumnMenu);
    if (dragBar) {
      const dr = dragBar.getBoundingClientRect();
      const [x, y] = [dr.left + dr.width / 2, dr.top + dr.height / 2];
      mouseAt("mousedown", x, y, dragBar);
      await wait(50);
      mouseAt("mouseup", x, y, dragBar);
      mouseAt("click", x, y, dragBar);
    }
    const rowMenu = await waitFor(() => shown(SEL.rowColumnMenu), 3000);
    const addRow = [...(rowMenu?.querySelectorAll("li.item") ?? [])].find((li) => li.textContent === "아래에 행 삽입");
    const rowsBefore = root.querySelectorAll("figure.mu-table tr").length;
    if (addRow) clickEl(addRow);
    await wait(250);
    const rowsAfter = root.querySelectorAll("figure.mu-table tr").length;
    const md = muya.getMarkdown();
    const lines = md.trimEnd().split("\n");
    // 원래 "1 | 2" 행 아래에 빈 행이 하나 생긴다.
    const rowAdded =
      rowsBefore === 2 && rowsAfter === 3 && lines.length === 4 && /^\|\s*1\s*\|\s*2\s*\|$/.test(lines[2]) && /^\|\s+\|\s+\|$/.test(lines[3]);
    check(
      "U06",
      "표: 열 툴바가 보이고, 행/열 메뉴의 \"아래에 행 삽입\"이 행을 늘리며, 드래그 바가 뜨고, 표 크기 선택(TableChessboard)이 열린다",
      chessboard && !columnBefore && overColumn && !dragBefore && dragSide === "right" && !menuBefore && !!addRow && rowAdded,
      JSON.stringify({ pickerBefore, grid, chessboard, columnBefore, columnTools: !!columnTools, overColumn, dragBefore, dragSide, menuBefore, rowMenu: !!rowMenu, addRow: !!addRow, rowsBefore, rowsAfter, md }),
    );
  }

  // ── U07 이미지 툴바·크기 조절 바·편집 도구(+경로 선택) ──────────────────────
  // 이미지(IMG)를 누르면 ImageSelection이 muya-image-toolbar·muya-transformer를 낸다. 툴바의 edit이 muya-image-selector.
  {
    await load("앞 문단\n\n![로고](logo.png)\n");
    const img = await waitFor(() => {
      const el = root.querySelector<HTMLImageElement>('img[src*="logo.png"]');
      return el && el.complete && el.naturalWidth > 0 ? el : null;
    }, 10000);
    const toolbarBefore = !!shown(SEL.imageToolbar);
    if (img) clickEl(img);
    const toolbar = await waitFor(() => shown(SEL.imageToolbar), 3000);
    // 크기 조절 바: .mu-transformer 안의 .bar.left/.right가 이미지 좌우 가장자리에 선다(ui/imageResizeBar _update).
    const frame = root.querySelector(".mu-image-container")?.getBoundingClientRect();
    const barAt = (side: "left" | "right") => {
      const bar = [...document.querySelectorAll(`.mu-transformer .bar.${side}`)].find((b) => visible(b));
      const r = bar?.getBoundingClientRect();
      if (!r || !frame || r.width === 0) return false;
      return near(r.left + r.width / 2, side === "left" ? frame.left : frame.right) && near(r.top + r.height / 2, frame.top + frame.height / 2);
    };
    const resizeBars = barAt("left") && barAt("right");

    const editBefore = !!shown(SEL.imageEdit);
    const editItem = toolbar?.querySelector("li.item.edit");
    if (editItem) clickEl(editItem);
    const editTool = await waitFor(() => shown(SEL.imageEdit), 3000);
    const src = editTool?.querySelector<HTMLInputElement>("input.src") ?? null;
    // 편집 도구는 열리며 경로 입력에 그 이미지의 src를 채우고 포커스를 준다.
    const srcReady = !!src && src.value === "logo.png" && document.activeElement === src;

    // ImagePathPicker(경로 자동완성 목록): 경로 입력의 keyup마다 편집 도구가 앱의 imagePathAutoComplete를
    // 불러 그 결과를 muya-image-picker로 넘기고, 목록이 비어 있지 않을 때만 뜬다(ui/imagePicker). 앱은 문서
    // 폴더의 이미지·폴더 목록을 Rust(list_image_paths)에서 받는다 — 모킹이 목록 하나를 돌려주게 하고,
    // 목록 요청과 경로 선택기가 실제로 보이는지까지 단정한다.
    respond("list_image_paths", () => [{ file: "logo.png", type: "file" }]);
    const pathPickerMounted = !!document.querySelector(SEL.imagePath);
    const handoffs: { reference?: unknown; list?: unknown }[] = [];
    const listen = (payload: unknown) => void handoffs.push(payload as { reference?: unknown; list?: unknown });
    muya.eventCenter.on("muya-image-picker", listen);
    if (src) {
      src.setSelectionRange(src.value.length, src.value.length);
      document.execCommand("insertText", false, "x");
      src.dispatchEvent(new KeyboardEvent("keyup", { key: "x", bubbles: true }));
    }
    await waitFor(() => handoffs.length > 0, 2000);
    muya.eventCenter.off("muya-image-picker", listen);
    const pathRequest = handoffs.length > 0 && handoffs[0].reference === src && Array.isArray(handoffs[0].list);
    const pathPicker = !!(await waitFor(() => shown(SEL.imagePath), 2000));
    check(
      "U07",
      "이미지를 누르면 툴바가 보이고, 크기 조절 바가 이미지 가장자리에 있으며, 편집 도구(경로 선택기 포함)가 열린다",
      !!img && !toolbarBefore && !!toolbar && resizeBars && !editBefore && !!editTool && srcReady && pathPickerMounted && pathRequest && pathPicker,
      JSON.stringify({ img: !!img, toolbarBefore, toolbar: !!toolbar, resizeBars, editBefore, editTool: !!editTool, srcValue: src?.value, srcReady, pathPickerMounted, pathRequest, pathPicker }),
    );
    // 편집 도구에 남은 포커스·상자를 거둔다.
    pressKey("Escape", {}, root);
    await settle();
  }

  // ── U08 링크 도구 ─────────────────────────────────────────────────────
  // 링크 래퍼(span.mu-link) mouseover에서 muya-link-tools(editor/linkMouseEvents.ts). 캐럿이 링크 밖이라
  // 표식이 숨은(.mu-hide) 상태여야 대상이다 — 캐럿은 첫 문단에 있다.
  {
    await load("첫 줄\n\n앞 [링크](https://example.com) 뒤\n");
    const link = root.querySelector('.mu-link[href="https://example.com"]');
    const before = !!shown(SEL.linkTools);
    const lr = link?.getBoundingClientRect();
    if (lr) mouseAt("mouseover", lr.left + lr.width / 2, lr.top + lr.height / 2);
    const tools = await waitFor(() => shown(SEL.linkTools), 3000);
    const tr = shownBox(tools);
    // placement bottom — 링크 바로 아래에, 링크와 가로로 겹쳐 선다.
    const belowLink = !!tr && !!lr && tr.top >= lr.bottom - 1 && tr.left < lr.right && tr.right > lr.left;
    const items = [...(tools?.querySelectorAll("li.item") ?? [])].map((li) => li.classList[1]);
    check(
      "U08",
      "링크 위에 올리면 링크 도구(링크 해제·열기)가 링크 아래에 보인다",
      !!link && !before && belowLink && JSON.stringify(items) === JSON.stringify(["unlink", "jump"]),
      JSON.stringify({ link: !!link, before, tools: !!tools, belowLink, items }),
    );
  }

  // ── U09 미리보기 툴바 ─────────────────────────────────────────────────
  // body mousemove 아래가 활성 아닌 math-block·diagram·html-block이면 그 블록 오른쪽 위 안쪽에 뜬다(ui/previewToolBar).
  {
    await load("첫 줄\n\n$$\nx^2\n$$\n");
    const block = await waitFor(() => [...root.querySelectorAll("figure.mu-math-block")].find((f) => f.querySelector(".katex")), 5000);
    const before = !!shown(SEL.previewTools);
    const br = block?.getBoundingClientRect();
    if (br) mouseAt("mousemove", br.left + br.width / 2, br.top + br.height / 2);
    const tools = await waitFor(() => shown(SEL.previewTools), 3000);
    const tr = shownBox(tools);
    const insideBlock = !!tr && !!br && tr.left >= br.left && tr.right <= br.right + 1 && tr.top >= br.top - 1 && tr.top < br.bottom;
    const items = [...(tools?.querySelectorAll("li.item") ?? [])].map((li) => li.classList[1]);
    check(
      "U09",
      "수식 블록 위에 올리면 미리보기 툴바(편집·삭제)가 그 블록 안 오른쪽 위에 보인다",
      !!block && !before && insideBlock && JSON.stringify(items) === JSON.stringify(["edit", "delete"]),
      JSON.stringify({ block: !!block, before, tools: !!tools, insideBlock, items }),
    );
  }
});

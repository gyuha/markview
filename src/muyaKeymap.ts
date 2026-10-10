/**
 * 편집 전용 모드(Muya)의 MarkText macOS 단축키. 키와 동작 id는 MarkText
 * `packages/desktop/src/main/keyboard/keybindingsDarwin.ts`(vendor/marktext-desktop에 사본) 그대로이고,
 * 동작은 MarkText 메뉴 액션(`main/menu/actions/{format,paragraph,edit}.ts`)이 엔진에 보내는 호출 그대로다.
 *
 * 들이는 것은 format·paragraph 전부와 편집 동작 12개다. cut·copy·paste는 브라우저 기본과 Muya의
 * 클립보드 처리가 맡고, 폴더 검색·스크린샷은 이 앱에 없는 기능이라 뺐다.
 */
import type { Muya } from "../vendor/muya/src/index";

/** [MarkText 키맵 id, MarkText 가속기 표기]. 하네스가 이 표를 원본 파일과 대조한다(K01). */
export const MARKTEXT_KEYMAP: ReadonlyArray<readonly [string, string]> = [
  ["edit.undo", "Command+Z"],
  ["edit.redo", "Command+Shift+Z"],
  ["edit.copy-as-rich", "Command+Shift+C"],
  ["edit.paste-as-plaintext", "Command+Shift+V"],
  ["edit.select-all", "Command+A"],
  ["edit.duplicate", "Command+Option+D"],
  ["edit.create-paragraph", "Shift+Command+N"],
  ["edit.delete-paragraph", "Shift+Command+D"],
  ["edit.find", "Command+F"],
  ["edit.find-next", "Cmd+G"],
  ["edit.find-previous", "Cmd+Shift+G"],
  ["edit.replace", "Command+Option+F"],
  ["paragraph.heading-1", "Command+1"],
  ["paragraph.heading-2", "Command+2"],
  ["paragraph.heading-3", "Command+3"],
  ["paragraph.heading-4", "Command+4"],
  ["paragraph.heading-5", "Command+5"],
  ["paragraph.heading-6", "Command+6"],
  ["paragraph.upgrade-heading", "Command+="],
  ["paragraph.degrade-heading", "Command+-"],
  ["paragraph.table", "Command+Shift+T"],
  ["paragraph.code-fence", "Command+Option+C"],
  ["paragraph.quote-block", "Command+Option+Q"],
  ["paragraph.math-formula", "Command+Option+M"],
  ["paragraph.html-block", "Command+Option+J"],
  ["paragraph.order-list", "Command+Option+O"],
  ["paragraph.bullet-list", "Command+Option+U"],
  ["paragraph.task-list", "Command+Option+X"],
  ["paragraph.loose-list-item", "Command+Option+L"],
  ["paragraph.paragraph", "Command+0"],
  ["paragraph.horizontal-line", "Command+Option+-"],
  ["paragraph.front-matter", "Command+Option+Y"],
  ["format.strong", "Command+B"],
  ["format.emphasis", "Command+I"],
  ["format.underline", "Command+U"],
  ["format.highlight", "Shift+Command+H"],
  ["format.inline-code", "Command+`"],
  ["format.inline-math", "Shift+Command+M"],
  ["format.strike", "Command+D"],
  ["format.hyperlink", "Command+L"],
  ["format.image", "Command+Shift+I"],
  ["format.clear-format", "Shift+Command+R"],
];

/** 키맵 동작이 앱에 부탁하는 것 — 표 크기 대화상자, 찾기/바꾸기 검색창. */
export interface KeymapHost {
  insertTable(muya: Muya): void;
  search(kind: "find" | "next" | "previous" | "replace"): void;
}

const FORMAT: Record<string, string> = {
  "format.strong": "strong",
  "format.emphasis": "em",
  "format.underline": "u",
  "format.highlight": "mark",
  "format.inline-code": "inline_code",
  "format.inline-math": "inline_math",
  "format.strike": "del",
  "format.hyperlink": "link",
  "format.image": "image",
  "format.clear-format": "clear",
};

const PARAGRAPH: Record<string, string> = {
  "paragraph.heading-1": "heading 1",
  "paragraph.heading-2": "heading 2",
  "paragraph.heading-3": "heading 3",
  "paragraph.heading-4": "heading 4",
  "paragraph.heading-5": "heading 5",
  "paragraph.heading-6": "heading 6",
  "paragraph.upgrade-heading": "upgrade heading",
  "paragraph.degrade-heading": "degrade heading",
  "paragraph.code-fence": "pre",
  "paragraph.quote-block": "blockquote",
  "paragraph.math-formula": "mathblock",
  "paragraph.html-block": "html",
  "paragraph.order-list": "ol-order",
  "paragraph.bullet-list": "ul-bullet",
  "paragraph.task-list": "ul-task",
  "paragraph.loose-list-item": "loose-list-item",
  "paragraph.paragraph": "paragraph",
  "paragraph.horizontal-line": "hr",
  "paragraph.front-matter": "front-matter",
};

/** 동작 id를 실행한다. MarkText editor.vue의 handleInlineFormat·handleEditParagraph·handleParagraph와 같다. */
export function runKeymapAction(id: string, muya: Muya, host: KeymapHost): void {
  if (id in FORMAT) return muya.format(FORMAT[id]);
  if (id === "paragraph.table") return host.insertTable(muya);
  if (id in PARAGRAPH) return muya.updateParagraph(PARAGRAPH[id]);
  switch (id) {
    case "edit.undo":
      return muya.undo();
    case "edit.redo":
      return muya.redo();
    case "edit.copy-as-rich":
      return muya.copyAsRich();
    case "edit.paste-as-plaintext":
      // ⇧⌘V는 메뉴 가속기라 웹뷰까지 오지 않는다 — 메뉴가 클립보드를 읽어 pastePlainText로 넘긴다.
      return;
    case "edit.select-all":
      return muya.selectAll();
    case "edit.duplicate":
      return muya.duplicate();
    case "edit.create-paragraph":
      return void muya.insertParagraph("after", "", true);
    case "edit.delete-paragraph":
      return muya.deleteParagraph();
    case "edit.find":
      return host.search("find");
    case "edit.find-next":
      return host.search("next");
    case "edit.find-previous":
      return host.search("previous");
    case "edit.replace":
      return host.search("replace");
  }
}

interface Chord {
  code: string;
  meta: boolean;
  alt: boolean;
  shift: boolean;
  ctrl: boolean;
}

/**
 * "Command+Option+C" → 키 코드와 수정자. ⌥를 누르면 event.key가 다른 글자(ç 등)로 바뀌므로
 * 글자가 아니라 물리 키(event.code)로 맞춘다.
 */
function parseAccelerator(accelerator: string): Chord {
  const parts = accelerator.split("+");
  const key = parts.pop()!;
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  const named: Record<string, string> = { "-": "Minus", "=": "Equal", "`": "Backquote", ",": "Comma" };
  const code = named[key] ?? (/^\d$/.test(key) ? `Digit${key}` : `Key${key.toUpperCase()}`);
  return {
    code,
    meta: mods.has("command") || mods.has("cmd"),
    alt: mods.has("option") || mods.has("alt"),
    shift: mods.has("shift"),
    ctrl: mods.has("control") || mods.has("ctrl"),
  };
}

const CHORDS = MARKTEXT_KEYMAP.map(([id, accelerator]) => ({ id, chord: parseAccelerator(accelerator) }));

/** 이 keydown에 걸린 키맵 id. 없으면 null. */
export function keymapIdFor(event: KeyboardEvent): string | null {
  const hit = CHORDS.find(
    ({ chord }) =>
      chord.code === event.code &&
      chord.meta === event.metaKey &&
      chord.alt === event.altKey &&
      chord.shift === event.shiftKey &&
      chord.ctrl === event.ctrlKey,
  );
  return hit?.id ?? null;
}

const SEARCH_IDS = new Set(["edit.find", "edit.find-next", "edit.find-previous", "edit.replace"]);

/**
 * Muya 편집 영역의 keydown을 키맵으로 보낸다. 캡처 단계에서 먼저 가져간다 — MarkText(Electron)에서는
 * 메뉴 가속기가 페이지보다 먼저 키를 받는다. 엔진의 내장 서식 단축키는 ⌥를 보지 않아서, 그대로 두면
 * ⌥⌘U(글머리 리스트)가 ⌘U(밑줄)로 먹힌다.
 *
 * 편집 영역을 담은 호스트(검색창도 여기 붙는다)에서 받는다. 검색 입력창 안에서는 찾기 계열만 처리한다 —
 * 메뉴 단축키라 어디서든 되던 ⌘G가 검색창에서도 되어야 하고, ⌘A·⌘Z는 입력창 자기 것이어야 한다.
 */
export function installKeymap(muya: Muya, host: KeymapHost): void {
  const scope = muya.domNode.parentElement ?? muya.domNode;
  scope.addEventListener(
    "keydown",
    (event) => {
      const id = keymapIdFor(event);
      if (!id) return;
      if (!muya.domNode.contains(event.target as Node) && !SEARCH_IDS.has(id)) return;
      event.preventDefault();
      event.stopPropagation();
      runKeymapAction(id, muya, host);
    },
    true,
  );
}

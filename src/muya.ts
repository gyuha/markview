/**
 * 편집 전용 모드의 편집기 — MarkText의 엔진 Muya를 MarkText 데스크톱과 같은 방식으로 띄운다.
 * 엔진은 `vendor/muya/src`에 고정 커밋 그대로 들여왔다 (ADR `261010-202536-edit-mode-vendored-marktext-muya`).
 * 배선의 원본은 MarkText `packages/desktop/src/renderer/src/components/editorWithTabs/editor.vue`다.
 *
 * main.ts는 이 모듈을 동적으로 불러온다 — 정적으로 import하면 뷰어로 열 때 내려받는 JS에
 * 엔진 전체(Prism·KaTeX·turndown…)가 실린다.
 */
import {
  CodeBlockLanguageSelector,
  EmojiSelector,
  FootnoteTool,
  ImageEditTool,
  ImagePathPicker,
  ImageResizeBar,
  ImageToolBar,
  InlineFormatToolbar,
  LinkTools,
  Muya,
  ParagraphFrontButton,
  ParagraphFrontMenu,
  ParagraphQuickInsertMenu,
  PreviewToolBar,
  TableChessboard,
  TableColumnToolbar,
  TableDragBar,
  TableRowColumMenu,
  ko,
  type IMuyaOptions,
} from "../vendor/muya/src/index";
import { invoke } from "@tauri-apps/api/core";
import { tableDialog } from "./modal";
import { installKeymap } from "./muyaKeymap";
import { closeSearch, runSearch } from "./muyaSearch";
import type { FormatId } from "./format";
import type { Effective } from "./theme";

export type MuyaEditor = Muya;

/** 앱이 엔진 플러그인에 넘기는 동작. 플러그인 등록은 전역 한 번이라 여기를 통해 늦게 묶는다. */
export interface MuyaHost {
  /** LinkTools의 링크 열기 — MarkText `jumpClick`(외부는 브라우저, 상대 .md는 새 탭)과 같은 의미. */
  openLink(href: string): void;
  /** 지금 편집 중인(활성 탭의) 문서 경로 — 전역 플러그인(ImageEditTool)의 이미지 저장 위치. */
  docPath(): string | null;
  notify(message: string): void;
}

/**
 * MarkText의 imageAction("문서 기준 상대 폴더" 방식) — 이미지를 문서 옆 assets/에 내용 해시 이름으로 넣고
 * 문서 기준 상대 경로를 돌려준다. 붙여넣은 비트맵은 data URL, 드롭·경로 선택은 절대 경로로 온다.
 * 원격 URL은 그대로 둔다. 실패하면 알리고 원래 src를 돌려준다(그림이 사라지지 않게).
 */
async function storeImage(docPath: string | null, src: string): Promise<string> {
  if (!docPath || /^https?:\/\//i.test(src)) return src;
  try {
    const data = /^data:image\/([\w+.-]+)(;base64)?,(.*)$/s.exec(src);
    if (data) {
      const ext = ({ jpeg: "jpg", "svg+xml": "svg" } as Record<string, string>)[data[1]] ?? data[1];
      const payload = data[2]
        ? data[3]
        : btoa(String.fromCharCode(...new TextEncoder().encode(decodeURIComponent(data[3]))));
      return await invoke<string>("save_asset", { docPath, ext, data: payload });
    }
    if (src.startsWith("/")) return await invoke<string>("copy_asset", { docPath, src });
  } catch (error) {
    host?.notify(`이미지를 저장하지 못했습니다: ${error}`);
  }
  return src;
}

let host: MuyaHost | null = null;

/**
 * `Muya.use`는 클래스 전역(`Muya.plugins`)에 쌓이고 `init()`마다 전부 인스턴스화된다 —
 * 탭마다 다시 등록하면 플러그인이 중복된다(editor.vue의 `muyaPluginsRegistered`와 같은 이유).
 * 순서는 editor.vue 그대로다.
 */
let pluginsRegistered = false;

function registerPlugins(): void {
  if (pluginsRegistered) return;
  pluginsRegistered = true;
  Muya.use(TableChessboard);
  Muya.use(ParagraphQuickInsertMenu);
  Muya.use(CodeBlockLanguageSelector);
  Muya.use(EmojiSelector);
  Muya.use(ImagePathPicker);
  Muya.use(ImageEditTool, {
    imageAction: ({ src }: { src: string }) => storeImage(host?.docPath() ?? null, src),
    // MarkText의 "경로 선택" — Rust가 파일 대화상자를 띄우고 고른 파일을 assets/로 복사해 상대 경로를 준다
    // (스크립트에 대화상자 권한을 주지 않는다). 취소면 빈 문자열 → 편집 도구가 그냥 닫힌다.
    imagePathPicker: async () => {
      const docPath = host?.docPath();
      if (!docPath) return "";
      try {
        return (await invoke<string | null>("pick_image", { docPath })) ?? "";
      } catch (error) {
        host?.notify(`이미지를 저장하지 못했습니다: ${error}`);
        return "";
      }
    },
    // MarkText editor.vue의 imagePathAutoComplete와 같은 모양({ text, iconClass, type }).
    imagePathAutoComplete: async (partial: string) => {
      const docPath = host?.docPath();
      if (!docPath) return [];
      const files = await invoke<{ file: string; type: string }[]>("list_image_paths", { docPath, partial });
      return (files ?? []).map((f) => ({
        ...f,
        iconClass: f.type === "directory" ? "icon-folder" : "icon-image",
        text: f.file + (f.type === "directory" ? "/" : ""),
      }));
    },
  });
  Muya.use(ImageResizeBar);
  Muya.use(ImageToolBar);
  Muya.use(InlineFormatToolbar);
  Muya.use(ParagraphFrontButton);
  Muya.use(ParagraphFrontMenu);
  Muya.use(PreviewToolBar);
  Muya.use(LinkTools, {
    jumpClick: (linkInfo: { href?: string | null } | null) => {
      if (linkInfo?.href) host?.openLink(linkInfo.href);
    },
  });
  Muya.use(FootnoteTool);
  Muya.use(TableColumnToolbar);
  Muya.use(TableDragBar);
  Muya.use(TableRowColumMenu);
}

/**
 * MarkText 기본 설정(`packages/desktop/static/preference.json`)의 편집 동작 값.
 * 엔진 기본값과 다른 것(trimUnnecessaryCodeBlockEmptyLines·superSubScript)이 있어
 * editor.vue처럼 전부 명시한다.
 */
const MARKTEXT_PREFERENCES: Partial<IMuyaOptions> = {
  preferLooseListItem: true,
  autoPairBracket: true,
  autoPairMarkdownSyntax: true,
  autoPairQuote: true,
  trimUnnecessaryCodeBlockEmptyLines: true,
  bulletListMarker: "-",
  orderListDelimiter: ".",
  tabSize: 4,
  fontSize: 16,
  lineHeight: 1.6,
  codeFontSize: 14,
  wrapCodeBlocks: false,
  codeBlockLineNumbers: false,
  listIndentation: 1,
  frontmatterType: "-",
  superSubScript: false,
  footnote: false,
  texMathDollars: true,
  texMathGfm: false,
  texMathSingleBackslash: false,
  texMathDoubleBackslash: false,
  highlightSyntax: false,
  inlineDiff: false,
  multilineBlockquote: false,
  disableHtml: false,
  softNewlineAsSpace: false,
  hideQuickInsertHint: false,
  hideLinkPopup: false,
  autoCheck: false,
  sequenceTheme: "hand",
  spellcheckEnabled: false,
};

/** 글꼴은 MarkText 테마가 아니라 이 앱의 것을 쓴다(테마 비채택 — ADR). */
const APP_FONTS: Partial<IMuyaOptions> = {
  editorFontFamily: '-apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", sans-serif',
  codeFontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
};

/** 다이어그램 테마는 실효 테마를 따른다 — editor.vue와 같은 짝(dark/dark, default/latimes). */
function diagramThemes(effective: Effective): Partial<IMuyaOptions> {
  return effective === "dark"
    ? { mermaidTheme: "dark", vegaTheme: "dark" }
    : { mermaidTheme: "default", vegaTheme: "latimes" };
}

/**
 * 편집기를 만든다. `onUserChange`는 사용자 편집(`json-change`의 source가 `user` — 입력·실행 취소 포함)
 * 때만 불린다. 엔진이 내용을 맞추느라 내는 `api` 변경(아래 `syncMuya`)은 원문을 건드리지 않아야
 * 편집 없이 모드만 오갈 때 재직렬화가 일어나지 않는다.
 */
export function createMuya(
  mount: HTMLElement,
  docPath: string,
  source: string,
  effective: Effective,
  appHost: MuyaHost,
  onUserChange: (markdown: string) => void,
): Muya {
  host = appHost;
  registerPlugins();
  const muya = new Muya(mount, {
    ...MARKTEXT_PREFERENCES,
    ...APP_FONTS,
    ...diagramThemes(effective),
    locale: ko,
    markdown: source,
    // "일반 텍스트로 붙여넣기"의 글자 — ⇧⌘V 메뉴가 Rust에서 읽어 넘긴 것(pastePlainText).
    clipboardText: async () => plainText,
    // 붙여넣은 이미지·pasteImage(드롭)를 문서 옆 assets/에 저장한다(엔진 옵션 — 플러그인 옵션과 별개).
    imageAction: ({ src }) => storeImage(docPath, src),
  });
  // 포커스는 호출자가 정한다 — 불러오는 사이 사용자가 다른 모드로 갔으면 숨은 Muya가 커서를 뺏으면 안 된다.
  muya.init({ focus: false });
  muya.on("json-change", (change: { source?: string }) => {
    if (change.source === "user") onUserChange(muya.getMarkdown());
  });
  // 실행 취소·다시 실행은 Muya 기록으로 보낸다. 엔진은 historyUndo/historyRedo 입력을 무시하므로
  // 그냥 두면 네이티브 Edit 메뉴(⌘Z)가 DOM만 되돌려 화면과 원문이 갈라진다(MarkText는 메뉴를 editor.undo로 보낸다).
  const runHistory = (event: InputEvent) => {
    if (event.inputType === "historyUndo") muya.undo();
    else if (event.inputType === "historyRedo") muya.redo();
  };
  muya.domNode.addEventListener(
    "beforeinput",
    (event) => {
      if (event.inputType !== "historyUndo" && event.inputType !== "historyRedo") return;
      event.preventDefault();
      runHistory(event);
    },
    true,
  );
  // beforeinput 없이 DOM부터 되돌리는 엔진(Chromium의 execCommand)도 있다 — 그때는 직후 input에서 Muya
  // 기록으로 되돌려 다시 그린다. beforeinput을 취소한 경우에는 input이 오지 않으므로 두 번 되돌리지 않는다.
  muya.domNode.addEventListener("input", (event) => runHistory(event as InputEvent), true);
  // MarkText macOS 단축키(⌘Z·⌘1~6·⌥⌘C…). 기본 동작을 막아 네이티브 실행 취소 등이 겹치지 않게 한다.
  installKeymap(muya, {
    insertTable,
    // 검색창은 이 편집기의 호스트(muya-host)에 붙는다 — Muya가 마운트 요소를 바꿔 끼워 domNode의 부모가 그 자리다.
    search: (kind) => runSearch(muya, muya.domNode.parentElement!, kind),
  });
  // 편집 중 링크는 ⌘-클릭으로 연다 — editor.vue의 format-click 처리와 같다.
  muya.on("format-click", ({ event, formatType, data }: { event: MouseEvent; formatType: string; data: unknown }) => {
    const href = (data as { href?: string } | null)?.href;
    if (formatType === "link" && event.metaKey && href) host?.openLink(href);
  });
  return muya;
}

/**
 * 다른 곳(분할 모드의 CodeMirror)에서 바뀐 원문을 들인다. MarkText가 소스 코드 모드에서
 * 돌아올 때와 같은 `replaceContent` — 실행 취소 한 단계로 묶이고 기존 기록은 남는다.
 */
export function syncMuya(muya: Muya, source: string): void {
  muya.replaceContent(source);
}

let plainText = "";

/**
 * 일반 텍스트로 붙여넣기(⇧⌘V). MarkText처럼 메뉴 가속기라, 사용자가 누를 때만 Rust가 클립보드를 읽어
 * 그 글자를 넘긴다 — 스크립트에는 클립보드 읽기 권한이 없다. 엔진은 clipboardText 옵션으로 그 글자를 읽는다.
 */
export async function pastePlainText(muya: Muya, text: string): Promise<void> {
  plainText = text;
  try {
    await muya.pasteAsPlainText();
  } finally {
    plainText = "";
  }
}

/**
 * 표 삽입(⇧⌘T) — MarkText처럼 행·열을 묻는 대화상자(기본 4×3)를 거쳐 커서 자리에 만든다.
 * 대화상자가 포커스를 가져가므로 닫은 뒤 편집기로 돌려주고 나서 만든다.
 */
async function insertTable(muya: Muya): Promise<void> {
  const size = await tableDialog({ rows: 4, columns: 3 });
  muya.focus();
  if (size) muya.createTable(size);
}

/** 상단 툴바 버튼 → MarkText가 같은 동작에 보내는 엔진 호출(메뉴 액션과 같은 타입 문자열). */
const TOOLBAR: Record<FormatId, (muya: Muya) => void> = {
  bold: (m) => m.format("strong"),
  italic: (m) => m.format("em"),
  strike: (m) => m.format("del"),
  code: (m) => m.format("inline_code"),
  link: (m) => m.format("link"),
  image: (m) => m.format("image"),
  h1: (m) => m.updateParagraph("heading 1"),
  h2: (m) => m.updateParagraph("heading 2"),
  h3: (m) => m.updateParagraph("heading 3"),
  h0: (m) => m.updateParagraph("paragraph"),
  list: (m) => m.updateParagraph("ul-bullet"),
  ordered: (m) => m.updateParagraph("ol-order"),
  codeblock: (m) => m.updateParagraph("pre"),
  quote: (m) => m.updateParagraph("blockquote"),
};

export function applyToolbarFormat(muya: Muya, id: FormatId): void {
  TOOLBAR[id](muya);
}

export { closeSearch };

export function applyMuyaTheme(muya: Muya, effective: Effective): void {
  muya.setOptions(diagramThemes(effective), true);
}

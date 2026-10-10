// 편집 전용 모드의 Muya 연결 — 마운트(M01–M04)·원문 동기화와 저장(S01–S04·S06)·테마(D01).
// `node harness/run.mjs muya`가 Chromium·WebKit에서 돌린다. 기대값은 상대편이 아니라 원문·상수와 비교한다.
import {
  activeTab,
  calls,
  check,
  clickMode,
  editorDoc,
  emitTauri,
  eq,
  guard,
  injectViaSplit,
  muyaOf,
  pressKey,
  ready,
  respond,
  typeAtEnd,
  visible,
  wait,
  waitFor,
} from "./lib-muya";
import { EditorView } from "@codemirror/view";
import * as engine from "../vendor/muya/src/index";

/** MarkText 데스크톱 editor.vue가 등록하는 UI 플러그인 17개. */
const MARKTEXT_PLUGINS = [
  "TableChessboard",
  "ParagraphQuickInsertMenu",
  "CodeBlockLanguageSelector",
  "EmojiSelector",
  "ImagePathPicker",
  "ImageEditTool",
  "ImageResizeBar",
  "ImageToolBar",
  "InlineFormatToolbar",
  "ParagraphFrontButton",
  "ParagraphFrontMenu",
  "PreviewToolBar",
  "LinkTools",
  "FootnoteTool",
  "TableColumnToolbar",
  "TableDragBar",
  "TableRowColumMenu",
];

/** MarkText static/preference.json 기본값(필수 ID M04의 목록). */
const MARKTEXT_OPTIONS: Record<string, unknown> = {
  bulletListMarker: "-",
  orderListDelimiter: ".",
  preferLooseListItem: true,
  autoPairBracket: true,
  autoPairMarkdownSyntax: true,
  autoPairQuote: true,
  tabSize: 4,
  listIndentation: 1,
  frontmatterType: "-",
  trimUnnecessaryCodeBlockEmptyLines: true,
  footnote: false,
  superSubScript: false,
  disableHtml: false,
  texMathDollars: true,
  hideQuickInsertHint: false,
  hideLinkPopup: false,
  autoCheck: false,
  codeBlockLineNumbers: false,
  wrapCodeBlocks: false,
};

/** Muya가 다시 쓰면 바뀌는 문서(리스트 사이 빈 줄·표 정렬) — 재직렬화가 새면 S01이 잡는다. */
const S01_DOC = "# 왕복\n\n- 하나\n\n1. 둘\n\n| a | b |\n| - | - |\n| 1 | 2 |\n";

const writes = () => calls().filter((c) => c.cmd === "write_markdown");

await guard(async () => {
  if (!(await ready())) return check("", "탭이 열렸다", false);
  respond("write_markdown", () => ({ conflict: false, mtime_ms: 2 }));
  const tab = activeTab()!;
  const preview = tab.pane.querySelector(".preview");

  // ── M01 연필 버튼과 F1 ───────────────────────────────────────────────
  clickMode("edit");
  const muya = await muyaOf(tab);
  const byButton = !!muya && visible(muya.domNode) && !visible(tab.editorHost) && !visible(preview);
  clickMode("view");
  pressKey("F1", {}, document.body);
  await wait(50);
  const byF1 = tab.mode === "edit" && !!muya && visible(muya.domNode) && !visible(tab.editorHost);
  check("M01", "연필 버튼·F1 → Muya 보임, CodeMirror 숨김", byButton && byF1, `button=${byButton} F1=${byF1}`);

  if (!muya) return check("", "Muya가 만들어졌다", false);
  // ── M02 분할·보기 ─────────────────────────────────────────────────
  clickMode("split");
  const split = visible(tab.editorHost) && visible(preview) && !visible(muya.domNode);
  clickMode("view");
  const view = !visible(tab.editorHost) && visible(preview) && !visible(muya.domNode);
  check("M02", "분할=CM+프리뷰, 보기=프리뷰, 두 모드에서 Muya 숨김", split && view, `split=${split} view=${view}`);

  // ── M03 플러그인 17개 ─────────────────────────────────────────────
  // 이름이 아니라 생성자 동일성으로 본다 — TableChessboard의 클래스 이름은 TablePicker다.
  const registered = (muya.constructor as unknown as { plugins: { plugin: unknown }[] }).plugins.map((p) => p.plugin);
  const exported = engine as unknown as Record<string, unknown>;
  const names = registered.map((plugin) => MARKTEXT_PLUGINS.find((n) => exported[n] === plugin) ?? "(MarkText 목록 밖)");
  eq("M03", "등록된 UI 플러그인 = MarkText editor.vue 17개", [...names].sort(), [...MARKTEXT_PLUGINS].sort());

  // ── M04 MarkText 기본 설정 ────────────────────────────────────────
  const options = muya.options as unknown as Record<string, unknown>;
  const actual = Object.fromEntries(Object.keys(MARKTEXT_OPTIONS).map((k) => [k, options[k]]));
  eq("M04", "Muya 옵션 = MarkText preference.json 기본값", actual, MARKTEXT_OPTIONS);

  // ── S01 편집 없는 왕복 ─────────────────────────────────────────────
  injectViaSplit(S01_DOC);
  emitTauri("save");
  await waitFor(() => !tab.dirty);
  const writesBefore = writes().length;
  clickMode("view");
  clickMode("edit");
  await wait(300);
  clickMode("split");
  clickMode("edit");
  await wait(300);
  clickMode("view");
  await wait(300);
  const roundTrip =
    editorDoc(tab) === S01_DOC &&
    tab.source === S01_DOC &&
    !tab.dirty &&
    !visible(tab.dirtyDot) &&
    writes().length === writesBefore;
  check(
    "S01",
    "편집 없이 보기→편집→분할→편집→보기 — 원문 바이트 유지·수정됨 아님·저장 0번",
    roundTrip,
    `doc=${JSON.stringify(editorDoc(tab))} dirty=${tab.dirty} writes=${writes().length - writesBefore}`,
  );
  // 픽스처가 재직렬화를 드러낼 수 있어야 S01이 의미가 있다.
  check("", "(S01 보조) 픽스처는 Muya가 다시 쓰면 바뀐다", muya.getMarkdown() !== S01_DOC);

  // ── S02 Muya 입력 → 수정됨·CM 반영 ─────────────────────────────────
  clickMode("edit");
  await wait(200);
  // 제목이 없으면(동기화가 깨진 경우) 첫 블록에 쓴다 — 예외로 멈추지 않고 뒤의 판정까지 가게.
  const heading = () =>
    muya.domNode.querySelector(".mu-atx-heading .mu-content") ?? muya.domNode.querySelector(".mu-content");
  await typeAtEnd(heading()!, "추가입력");
  const dirtyAfterType = tab.dirty && visible(tab.dirtyDot);
  clickMode("split");
  const s02 = dirtyAfterType && (editorDoc(tab) ?? "").includes("# 왕복추가입력");
  check("S02", "Muya 입력 → 수정됨 표시·분할의 CM에 반영", s02, `dirty=${dirtyAfterType} doc=${JSON.stringify(editorDoc(tab))}`);

  // ── S03 분할에서 고친 내용 → 편집 모드 ───────────────────────────────
  const cm = EditorView.findFromDOM(tab.editorHost)!;
  cm.dispatch({ changes: { from: cm.state.doc.length, insert: "\n분할에서 쓴 줄\n" } });
  clickMode("edit");
  await wait(300);
  const s03 =
    muya.getMarkdown().includes("분할에서 쓴 줄") && (muya.domNode.textContent ?? "").includes("분할에서 쓴 줄");
  check("S03", "분할(CM)에서 고친 내용이 편집 모드의 Muya에 보인다", s03, JSON.stringify(muya.getMarkdown()));

  // ── S04 저장 = getMarkdown ───────────────────────────────────────────
  await typeAtEnd(heading()!, "저장확인");
  const writesBeforeSave = writes().length;
  emitTauri("save");
  await waitFor(() => writes().length > writesBeforeSave);
  const saved = writes().slice(-1)[0]?.args?.text;
  eq("S04", "편집 모드 저장 본문 = Muya getMarkdown()", saved, muya.getMarkdown());
  check("", "(S04 보조) 저장 본문에 마지막 입력이 들어 있다", typeof saved === "string" && saved.includes("저장확인"));

  // ── S06 미저장 닫기 확인 ─────────────────────────────────────────────
  await typeAtEnd(heading()!, "닫기확인");
  tab.button.querySelector<HTMLElement>(".tab-close")!.click();
  const modal = await waitFor(() => document.querySelector(".modal-backdrop"));
  check("S06", "Muya에서 수정한 탭을 닫으려 하면 미저장 확인 대화상자", !!modal && visible(modal), `dirty=${tab.dirty}`);
  document.querySelector<HTMLElement>(".modal-backdrop .modal-cancel")?.click();
  await waitFor(() => !document.querySelector(".modal-backdrop"));

  // ── D01 테마 ─────────────────────────────────────────────────────────
  const container = () => muya.domNode.querySelector(".mu-container")!;
  const paint = async (choice: "light" | "dark", mermaid: string) => {
    document.querySelector<HTMLElement>(`#theme [data-choice="${choice}"]`)!.click();
    await waitFor(() => document.documentElement.dataset.theme === choice && muya.options.mermaidTheme === mermaid);
    return {
      bg: getComputedStyle(muya.domNode).backgroundColor,
      fg: getComputedStyle(container()).color,
      mermaid: muya.options.mermaidTheme,
    };
  };
  const light = await paint("light", "default");
  const dark = await paint("dark", "dark");
  eq(
    "D01",
    "라이트/다크에서 Muya 배경·글자색·mermaid 테마가 앱 팔레트를 따른다",
    { light, dark },
    {
      light: { bg: "rgb(255, 255, 255)", fg: "rgb(31, 35, 40)", mermaid: "default" },
      dark: { bg: "rgb(13, 17, 23)", fg: "rgb(230, 237, 243)", mermaid: "dark" },
    },
  );
  // 다음 하네스에 남기지 않는다(mock-tauri가 시작 시 지우지만 명시해 둔다).
  document.querySelector<HTMLElement>('#theme [data-choice="system"]')!.click();
});

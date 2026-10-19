import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { Compartment, EditorState } from "@codemirror/state";
import {
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { formatCommand } from "./format";
import type { Palette } from "./theme";

/** 테마만 바꿔 끼울 수 있도록 격리한다 — 문서와 커서를 잃지 않고 교체된다. */
const themeCompartment = new Compartment();

/** 마크다운 문법 강조. 색은 팔레트 변수에서 가져와 프리뷰·Muya와 같은 색상 테마를 따른다. */
function highlightStyle(palette: Palette): HighlightStyle {
  const v = palette.vars;
  return HighlightStyle.define([
    { tag: tags.heading, color: v["--tok-func"], fontWeight: "600" },
    { tag: tags.strong, color: v["--fg"], fontWeight: "600" },
    { tag: tags.emphasis, fontStyle: "italic" },
    { tag: tags.strikethrough, textDecoration: "line-through" },
    { tag: tags.link, color: v["--link"] },
    { tag: tags.url, color: v["--link"] },
    { tag: tags.monospace, color: v["--tok-string"] },
    { tag: tags.quote, color: v["--fg-muted"] },
    // `#`, `*`, 백틱 같은 문법 기호와 `---` 구분선
    { tag: tags.processingInstruction, color: v["--fg-muted"] },
    { tag: tags.contentSeparator, color: v["--fg-muted"] },
    { tag: tags.meta, color: v["--fg-muted"] },
  ]);
}

/** CSS 변수는 CM6 테마 객체에서 읽히지 않아 팔레트의 값을 직접 적는다. */
function editorTheme(palette: Palette) {
  const v = palette.vars;
  return EditorView.theme(
    {
      "&": { color: v["--fg"], backgroundColor: v["--bg"] },
      ".cm-content": { caretColor: v["--fg"] },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: v["--fg"] },
      ".cm-gutters": { color: v["--fg-muted"], backgroundColor: v["--code-bg"], border: "none" },
      ".cm-activeLine": { backgroundColor: v["--code-bg"] },
      ".cm-activeLineGutter": { backgroundColor: v["--editor-color-10"] },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
        backgroundColor: v["--selection-color"],
      },
    },
    { dark: palette.kind === "dark" },
  );
}

/**
 * 편집기를 만든다. `onChange`는 디바운스되지 않은 원문 그대로를 넘긴다 —
 * 디바운스는 호출자(프리뷰 갱신)의 책임이다.
 */
export function createEditor(
  host: HTMLElement,
  source: string,
  palette: Palette,
  onChange: (next: string) => void,
): EditorView {
  return new EditorView({
    parent: host,
    state: EditorState.create({
      doc: source,
      extensions: [
        // basicSetup 대신 필요한 것만 — 메타 패키지는 자동완성·린트·검색·코드폴딩까지 끌어와
        // 번들을 660KB 늘린다. 마크다운 편집에는 쓰이지 않는다.
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        history(),
        // 서식 단축키를 먼저 둬야 기본 키맵보다 우선한다. Edit 메뉴에 없는 키라 충돌하지 않는다.
        keymap.of([
          { key: "Mod-b", run: formatCommand("bold") },
          { key: "Mod-i", run: formatCommand("italic") },
        ]),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        // 산문 편집에 필수 — 없으면 긴 줄이 가로로 흐른다.
        EditorView.lineWrapping,
        markdown(),
        themeCompartment.of([
          editorTheme(palette),
          syntaxHighlighting(highlightStyle(palette)),
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChange(update.state.doc.toString());
        }),
      ],
    }),
  });
}

/** 테마 5번째 겹. 문서를 유지한 채 테마 확장만 교체한다. */
export function applyEditorTheme(view: EditorView, palette: Palette): void {
  view.dispatch({
    effects: themeCompartment.reconfigure([
      editorTheme(palette),
      syntaxHighlighting(highlightStyle(palette)),
    ]),
  });
}

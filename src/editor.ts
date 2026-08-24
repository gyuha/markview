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
import type { Effective } from "./theme";

/** 테마만 바꿔 끼울 수 있도록 격리한다 — 문서와 커서를 잃지 않고 교체된다. */
const themeCompartment = new Compartment();

/**
 * 마크다운 문법 강조. 색은 문서 프리뷰의 highlight.js 테마와 같은 계열(github light/dark)로 맞춘다.
 * 기본 highlight style은 라이트 색이 고정이라 다크에서 읽히지 않으므로 두 벌을 둔다.
 */
function highlightStyle(effective: Effective): HighlightStyle {
  const dark = effective === "dark";
  return HighlightStyle.define([
    { tag: tags.heading, color: dark ? "#79c0ff" : "#0550ae", fontWeight: "600" },
    { tag: tags.strong, color: dark ? "#e6edf3" : "#1f2328", fontWeight: "600" },
    { tag: tags.emphasis, fontStyle: "italic" },
    { tag: tags.strikethrough, textDecoration: "line-through" },
    { tag: tags.link, color: dark ? "#4493f8" : "#0969da" },
    { tag: tags.url, color: dark ? "#4493f8" : "#0969da" },
    { tag: tags.monospace, color: dark ? "#a5d6ff" : "#0a3069" },
    { tag: tags.quote, color: dark ? "#9198a1" : "#59636e" },
    // `#`, `*`, 백틱 같은 문법 기호와 `---` 구분선
    { tag: tags.processingInstruction, color: dark ? "#9198a1" : "#59636e" },
    { tag: tags.contentSeparator, color: dark ? "#9198a1" : "#59636e" },
    { tag: tags.meta, color: dark ? "#9198a1" : "#59636e" },
  ]);
}

/** 색은 앱 팔레트와 같은 값을 쓴다. CSS 변수는 CM6 테마 객체에서 읽히지 않아 직접 적는다. */
function editorTheme(effective: Effective) {
  const dark = effective === "dark";
  return EditorView.theme(
    {
      "&": {
        color: dark ? "#e6edf3" : "#1f2328",
        backgroundColor: dark ? "#0d1117" : "#ffffff",
      },
      ".cm-content": { caretColor: dark ? "#e6edf3" : "#1f2328" },
      ".cm-cursor, .cm-dropCursor": {
        borderLeftColor: dark ? "#e6edf3" : "#1f2328",
      },
      ".cm-gutters": {
        color: dark ? "#9198a1" : "#59636e",
        backgroundColor: dark ? "#151b23" : "#f6f8fa",
        border: "none",
      },
      ".cm-activeLine": {
        backgroundColor: dark ? "#151b23" : "#f6f8fa",
      },
      ".cm-activeLineGutter": {
        backgroundColor: dark ? "#1c232c" : "#eaeef2",
      },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
        backgroundColor: dark ? "#1f3b5c" : "#dbe9f8",
      },
    },
    { dark },
  );
}

/**
 * 편집기를 만든다. `onChange`는 디바운스되지 않은 원문 그대로를 넘긴다 —
 * 디바운스는 호출자(프리뷰 갱신)의 책임이다.
 */
export function createEditor(
  host: HTMLElement,
  source: string,
  effective: Effective,
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
          editorTheme(effective),
          syntaxHighlighting(highlightStyle(effective)),
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChange(update.state.doc.toString());
        }),
      ],
    }),
  });
}

/** 테마 5번째 겹. 문서를 유지한 채 테마 확장만 교체한다. */
export function applyEditorTheme(view: EditorView, effective: Effective): void {
  view.dispatch({
    effects: themeCompartment.reconfigure([
      editorTheme(effective),
      syntaxHighlighting(highlightStyle(effective)),
    ]),
  });
}

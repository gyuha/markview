import { EditorSelection, type EditorState, type TransactionSpec } from "@codemirror/state";
import type { Command } from "@codemirror/view";

export type FormatId =
  | "bold"
  | "italic"
  | "strike"
  | "list"
  | "ordered"
  | "quote"
  | "link"
  | "image"
  | "h0"
  | "h1"
  | "h2"
  | "h3"
  | "code"
  | "codeblock";

const MARKS: Record<string, string> = { bold: "**", italic: "*", strike: "~~" };

/**
 * 서식 변환을 상태 → 트랜잭션으로 계산한다. EditorView가 아니라 EditorState만 받으므로
 * DOM 없이 검증할 수 있다 (하네스가 이 함수를 직접 호출한다).
 */
export function applyFormat(state: EditorState, id: FormatId): TransactionSpec {
  if (id[0] === "h" && id.length === 2) return setHeading(state, Number(id.slice(1)));
  if (id === "code") return toggleWrap(state, "`");
  if (id === "codeblock") return codeBlock(state);
  if (id === "list" || id === "ordered" || id === "quote") return prefixLines(state, id);
  if (id === "link" || id === "image") return insertLink(state, id === "image");
  return toggleWrap(state, MARKS[id]);
}

export function formatCommand(id: FormatId): Command {
  return (view) => {
    view.dispatch(applyFormat(view.state, id));
    view.focus();
    return true;
  };
}

/** 감싸기는 토글이다. 이미 감싸져 있으면 표시를 걷어낸다. */
function toggleWrap(state: EditorState, mark: string): TransactionSpec {
  const m = mark.length;
  return state.changeByRange((range) => {
    const inner = state.sliceDoc(range.from, range.to);

    // 선택이 표시까지 포함한 경우
    if (inner.length >= m * 2 && inner.startsWith(mark) && inner.endsWith(mark)) {
      const stripped = inner.slice(m, -m);
      return {
        changes: { from: range.from, to: range.to, insert: stripped },
        range: EditorSelection.range(range.from, range.from + stripped.length),
      };
    }

    // 선택이 표시 안쪽인 경우 — 한 번 감싸면 선택이 안쪽에 남으므로 다시 누르면 여기로 온다.
    const before = state.sliceDoc(Math.max(0, range.from - m), range.from);
    const after = state.sliceDoc(range.to, Math.min(state.doc.length, range.to + m));
    if (before === mark && after === mark) {
      return {
        changes: [
          { from: range.from - m, to: range.from },
          { from: range.to, to: range.to + m },
        ],
        range: EditorSelection.range(range.from - m, range.to - m),
      };
    }

    return {
      changes: { from: range.from, to: range.to, insert: `${mark}${inner}${mark}` },
      range: EditorSelection.range(range.from + m, range.from + m + inner.length),
    };
  });
}

/**
 * 선택에 걸친 모든 줄 앞에 접두어를 넣는다. 다중 커서는 같은 줄을 두 번 건드릴 수 있어
 * 주 선택만 대상으로 한다.
 */
function prefixLines(state: EditorState, id: "list" | "ordered" | "quote"): TransactionSpec {
  const range = state.selection.main;
  const first = state.doc.lineAt(range.from).number;
  const last = state.doc.lineAt(range.to).number;
  const changes = [];
  for (let no = first; no <= last; no++) {
    const insert = id === "ordered" ? `${no - first + 1}. ` : id === "list" ? "- " : "> ";
    changes.push({ from: state.doc.line(no).from, insert });
  }
  // 선택은 트랜잭션이 알아서 밀어준다.
  return { changes };
}

/** 선택이 있으면 그것을 라벨로 쓰고 `url`을 선택해 둔다. 없으면 대괄호 안에 커서를 둔다. */
function insertLink(state: EditorState, image: boolean): TransactionSpec {
  const open = image ? "![" : "[";
  return state.changeByRange((range) => {
    const label = state.sliceDoc(range.from, range.to);
    const urlStart = range.from + open.length + label.length + 2;
    return {
      changes: { from: range.from, to: range.to, insert: `${open}${label}](url)` },
      range: label
        ? EditorSelection.range(urlStart, urlStart + 3)
        : EditorSelection.cursor(range.from + open.length),
    };
  });
}

/** 줄 앞 `#` 개수. 헤딩이 아니면 0. `#태그`처럼 공백이 없으면 헤딩이 아니다. */
export function headingLevel(text: string): number {
  const m = /^(#{1,6})\s/.exec(text);
  return m ? m[1].length : 0;
}

/** 팝오버에 현재 선택 상태를 표시하기 위해 커서가 있는 줄의 레벨을 읽는다. */
export function activeHeading(state: EditorState): number {
  return headingLevel(state.doc.lineAt(state.selection.main.from).text);
}

/**
 * 선택에 걸친 줄의 헤딩 레벨을 바꾼다. 같은 레벨을 다시 고르면 해제한다 —
 * 해제 여부는 첫 줄을 기준으로 한 번만 정해서 여러 줄이 갈리지 않게 한다.
 */
function setHeading(state: EditorState, level: number): TransactionSpec {
  const range = state.selection.main;
  const first = state.doc.lineAt(range.from).number;
  const last = state.doc.lineAt(range.to).number;
  const target = headingLevel(state.doc.line(first).text) === level ? 0 : level;
  const insert = target === 0 ? "" : `${"#".repeat(target)} `;

  const changes = [];
  for (let no = first; no <= last; no++) {
    const line = state.doc.line(no);
    const existing = /^#{1,6}\s+/.exec(line.text)?.[0].length ?? 0;
    changes.push({ from: line.from, to: line.from + existing, insert });
  }
  return { changes };
}

/** 선택에 걸친 줄 전체를 펜스로 감싼다. 인라인 코드는 toggleWrap이 맡는다. */
function codeBlock(state: EditorState): TransactionSpec {
  const range = state.selection.main;
  const first = state.doc.lineAt(range.from);
  const last = state.doc.lineAt(range.to);
  return {
    changes: [
      { from: first.from, insert: "```\n" },
      { from: last.to, insert: "\n```" },
    ],
  };
}

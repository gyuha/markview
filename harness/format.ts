// 서식 명령 검증. DOM이 필요 없다 (EditorState만 쓴다) — `pnpm test:format`.
import { EditorSelection, EditorState } from "@codemirror/state";
import { applyFormat, type FormatId } from "../src/format.ts";

let fail = 0;
function run(name: string, doc: string, sel: [number, number], id: FormatId) {
  const state = EditorState.create({ doc, selection: EditorSelection.single(sel[0], sel[1]) });
  const next = state.update(applyFormat(state, id)).state;
  return { text: next.doc.toString(), sel: next.selection.main, name };
}
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
}

// 1) 감싸기 + 토글 원복
const b1 = run("bold", "굵게", [0, 2], "bold");
eq("선택 굵게 → **굵게**", b1.text, "**굵게**");
eq("  선택이 표시 안쪽에 남음", [b1.sel.from, b1.sel.to], [2, 4]);
// 두 번째 적용: 위 결과 상태 그대로
{
  const s = EditorState.create({ doc: b1.text, selection: EditorSelection.single(2, 4) });
  const n = s.update(applyFormat(s, "bold")).state;
  eq("한 번 더 → 원복", n.doc.toString(), "굵게");
}
{ // 표시를 포함해 선택한 경우도 해제
  const s = EditorState.create({ doc: "**굵게**", selection: EditorSelection.single(0, 6) });
  const n = s.update(applyFormat(s, "bold")).state;
  eq("표시 포함 선택 → 해제", n.doc.toString(), "굵게");
}
eq("기울임", run("i", "기울", [0, 2], "italic").text, "*기울*");
eq("취소선", run("s", "취소", [0, 2], "strike").text, "~~취소~~");

// 2) 여러 줄 접두어
eq("3줄 목록", run("l", "가\n나\n다", [0, 5], "list").text, "- 가\n- 나\n- 다");
eq("3줄 번호목록", run("o", "가\n나\n다", [0, 5], "ordered").text, "1. 가\n2. 나\n3. 다");
eq("3줄 인용", run("q", "가\n나\n다", [0, 5], "quote").text, "> 가\n> 나\n> 다");
eq("한 줄만 선택되면 그 줄만", run("l", "가\n나\n다", [0, 1], "list").text, "- 가\n나\n다");

// 3) 링크 / 이미지
const l1 = run("link", "", [0, 0], "link");
eq("커서만 + 링크 → [](url)", l1.text, "[](url)");
eq("  커서는 대괄호 안", [l1.sel.from, l1.sel.to], [1, 1]);
const l2 = run("link", "제목", [0, 2], "link");
eq("선택 + 링크", l2.text, "[제목](url)");
eq("  url이 선택됨", l2.text.slice(l2.sel.from, l2.sel.to), "url");
const i1 = run("img", "", [0, 0], "image");
eq("커서만 + 이미지 → ![](url)", i1.text, "![](url)");
eq("  커서는 대괄호 안", [i1.sel.from, i1.sel.to], [2, 2]);

// 4) 문서 중간에서도 위치가 맞는지
eq("문서 중간 굵게", run("m", "앞 가운데 뒤", [2, 5], "bold").text, "앞 **가운데** 뒤");

// 5) 헤딩 레벨 전환
eq("없음 → H1", run("h", "제목", [0, 0], "h1").text, "# 제목");
eq("H1 → H2", run("h", "# 제목", [2, 2], "h2").text, "## 제목");
eq("H2에서 H2 재선택 → 해제", run("h", "## 제목", [3, 3], "h2").text, "제목");
eq("H3 → 해제 버튼", run("h", "### 제목", [4, 4], "h0").text, "제목");
eq("여러 줄 헤딩은 첫 줄 기준으로 일괄", run("h", "가\n나", [0, 3], "h2").text, "## 가\n## 나");
eq("#태그는 헤딩이 아니다", run("h", "#태그", [0, 0], "h1").text, "# #태그");

// 6) 코드
eq("인라인 코드", run("c", "코드", [0, 2], "code").text, "`코드`");
eq("  두 번 → 원복", run("c", "`코드`", [1, 3], "code").text, "코드");
eq("코드블록(여러 줄 선택)", run("c", "가\n나", [0, 3], "codeblock").text, "```\n가\n나\n```");
eq("여러 줄 선택 + 인라인은 인라인 그대로", run("c", "가\n나", [0, 3], "code").text, "`가\n나`");

console.log(fail === 0 ? "\n전부 통과" : `\n실패 ${fail}건`);
process.exit(fail === 0 ? 0 : 1);

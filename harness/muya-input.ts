// Muya 입력 규칙(I01–I07) — 마크다운 단축 입력·자동 짝·실행 취소. 편집은 DOM 입력으로만 일으킨다
// (execCommand insertText, keydown). 엔진 API는 판정(getMarkdown)에만 쓴다.
import {
  activeTab,
  check,
  clickMode,
  editorDoc,
  guard,
  injectViaSplit,
  muyaOf,
  pressKey,
  ready,
  wait,
} from "./lib-muya";
import type { MuyaEditor } from "../src/muya";

await guard(async () => {
  if (!(await ready())) return check("", "탭이 열렸다", false);
  const tab = activeTab()!;
  clickMode("edit");
  const muya = await muyaOf(tab);
  if (!muya) return check("", "Muya가 만들어졌다", false);

  /** 문서를 "시작" 한 문단으로 되돌리고, 그 끝에서 Enter로 빈 문단을 만들어 캐럿을 둔다. */
  async function emptyParagraph(m: MuyaEditor): Promise<void> {
    injectViaSplit("시작\n");
    clickMode("edit");
    await wait(250);
    const content = m.domNode.querySelector(".mu-paragraph .mu-content")!;
    const range = document.createRange();
    range.selectNodeContents(content);
    range.collapse(false);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
    await wait(30);
    pressKey("Enter", {}, content);
    await wait(150);
  }

  async function type(text: string): Promise<void> {
    for (const ch of text) {
      document.execCommand("insertText", false, ch);
      await wait(20);
    }
    await wait(120);
  }

  /** 캐럿이 있는 블록 요소. */
  const caretBlock = () => (getSelection()?.anchorNode?.parentElement ?? null)?.closest("h1, h2, li, blockquote, pre, figure, p");

  // I01 "# " → h1
  await emptyParagraph(muya);
  await type("# 큰제목");
  const i01 = !!caretBlock()?.closest("h1") && muya.getMarkdown().includes("\n# 큰제목");
  check("I01", "빈 문단에 \"# \" 입력 → h1", i01, JSON.stringify(muya.getMarkdown()));

  // I02 "- " → ul, "1. " → ol, "- [ ] " → 체크박스 리스트
  await emptyParagraph(muya);
  await type("- 글머리");
  const ul = !!caretBlock()?.closest("ul") && muya.getMarkdown().includes("- 글머리");
  await emptyParagraph(muya);
  await type("1. 번호");
  const ol = !!caretBlock()?.closest("ol") && muya.getMarkdown().includes("1. 번호");
  await emptyParagraph(muya);
  await type("- [ ] 할일");
  const task = !!caretBlock()?.closest("li")?.querySelector('input[type="checkbox"]') && muya.getMarkdown().includes("- [ ] 할일");
  check("I02", "\"- \"·\"1. \"·\"- [ ] \" → ul·ol·체크박스 리스트", ul && ol && task, JSON.stringify({ ul, ol, task, md: muya.getMarkdown() }));

  // I03 "> " → blockquote
  await emptyParagraph(muya);
  await type("> 인용문");
  const i03 = !!caretBlock()?.closest("blockquote") && muya.getMarkdown().includes("> 인용문");
  check("I03", "\"> \" → blockquote", i03, JSON.stringify(muya.getMarkdown()));

  // I04 "```" + Enter → 코드블록
  await emptyParagraph(muya);
  await type("```");
  pressKey("Enter", {}, getSelection()!.anchorNode!.parentElement);
  await wait(200);
  const i04 = muya.domNode.querySelectorAll("pre.mu-code-block").length === 1 && muya.getMarkdown().includes("```");
  check("I04", "\"```\" + Enter → 코드블록", i04, JSON.stringify(muya.getMarkdown()));

  // I05 "| a | b |" + Enter → 열 2개 표
  await emptyParagraph(muya);
  await type("| a | b |");
  pressKey("Enter", {}, getSelection()!.anchorNode!.parentElement);
  await wait(200);
  const firstRow = muya.domNode.querySelectorAll("figure.mu-table table tr:first-child td").length;
  check("I05", "\"| a | b |\" + Enter → 열 2개짜리 표", firstRow === 2, `cells=${firstRow} md=${JSON.stringify(muya.getMarkdown())}`);

  // I06 "(" → "()", "**" → "****"
  await emptyParagraph(muya);
  await type("(");
  const paren = (getSelection()?.anchorNode?.parentElement?.closest(".mu-content")?.textContent ?? "") === "()";
  await emptyParagraph(muya);
  await type("**");
  const starText = getSelection()?.anchorNode?.parentElement?.closest(".mu-content")?.textContent ?? "";
  check("I06", "\"(\" → \"()\", \"**\" → \"****\" (MarkText autoPair)", paren && starText === "****", JSON.stringify({ paren, starText }));

  // I07 ⌘Z / ⇧⌘Z
  await emptyParagraph(muya);
  await type("되돌림");
  const typed = muya.getMarkdown().includes("되돌림");
  // 실제 키 입력처럼 물리 키(code)를 함께 보낸다 — 키맵은 ⌥ 조합 때문에 code로 키를 맞춘다.
  pressKey("z", { code: "KeyZ", metaKey: true }, muya.domNode);
  await wait(150);
  const undone = !muya.getMarkdown().includes("되돌림") && !tab.source.includes("되돌림");
  pressKey("z", { code: "KeyZ", metaKey: true, shiftKey: true }, muya.domNode);
  await wait(150);
  const redone = muya.getMarkdown().includes("되돌림") && tab.source.includes("되돌림");
  clickMode("split");
  const cm = (editorDoc(tab) ?? "").includes("되돌림");
  check("I07", "⌘Z가 직전 입력을 되돌리고 ⇧⌘Z가 다시 적용", typed && undone && redone && cm, JSON.stringify({ typed, undone, redone, cm }));
});

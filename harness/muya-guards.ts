// Muya 연결의 데이터 손실 가드(task 18 적대적 리뷰에서 실측된 결함). 필수 ID는 없지만
// FAIL 줄이 하나라도 있으면 run.mjs가 실패로 본다 — 결함이 되살아나면 C3가 잡는다.
import { EditorView } from "@codemirror/view";
import { undo } from "@codemirror/commands";
import {
  activeTab,
  calls,
  check,
  clickMode,
  editorDoc,
  eq,
  guard,
  injectViaSplit,
  muyaOf,
  pressKey,
  ready,
  typeAtEnd,
  visible,
  wait,
  waitFor,
} from "./lib-muya";

const DOC = "alpha beta gamma\n\nsecond para\n";

await guard(async () => {
  if (!(await ready())) return check("", "탭이 열렸다", false);
  const tab = activeTab()!;
  injectViaSplit(DOC);
  clickMode("edit");
  const muya = await muyaOf(tab);
  if (!muya) return check("", "Muya가 만들어졌다", false);
  await wait(200);
  const firstBlock = () => muya.domNode.querySelector(".mu-paragraph .mu-content")!;

  // 1) 입력 직후 곧바로 분할 — 묶여 있던 입력이 CM에 들어가야 한다.
  const range = document.createRange();
  range.selectNodeContents(firstBlock());
  range.collapse(false);
  getSelection()!.removeAllRanges();
  getSelection()!.addRange(range);
  document.execCommand("insertText", false, "Q");
  clickMode("split");
  check("", "입력 직후 바로 분할로 가도 CM에 마지막 입력이 있다", (editorDoc(tab) ?? "").startsWith("alpha beta gammaQ"), JSON.stringify(editorDoc(tab)));

  // 2) 네이티브 경로의 실행 취소(Edit 메뉴 ⌘Z = historyUndo) — 화면과 원문이 같은 상태로 되돌아가야 한다.
  clickMode("edit");
  await wait(200);
  await typeAtEnd(firstBlock(), "XYZ");
  document.execCommand("undo");
  await wait(150);
  const shown = muya.domNode.querySelector(".mu-paragraph")?.textContent ?? "";
  check(
    "",
    "네이티브 실행 취소 후 화면·getMarkdown·원문이 같다",
    !shown.includes("XYZ") && !muya.getMarkdown().includes("XYZ") && !tab.source.includes("XYZ"),
    JSON.stringify({ shown, md: muya.getMarkdown(), source: tab.source }),
  );

  // 3) Muya 원문을 CM에 들인 뒤 CM 실행 취소 — 지운 글자가 엉뚱한 곳에 되살아나면 안 된다.
  clickMode("split");
  const view = EditorView.findFromDOM(tab.editorHost)!;
  const text = view.state.doc.toString();
  const at = text.indexOf("beta ");
  view.dispatch({ changes: { from: at, to: at + "beta ".length } });
  const afterDelete = view.state.doc.toString();
  clickMode("edit");
  await wait(200);
  await typeAtEnd(firstBlock(), "M");
  clickMode("split");
  undo(view);
  eq("", "동기화 뒤 CM 실행 취소는 동기화 이전(내가 지운 상태)으로 돌아간다", view.state.doc.toString(), afterDelete);

  // 4) 미저장 상태의 ⌘R — 확인 없이 편집을 버리면 안 된다.
  clickMode("edit");
  await wait(200);
  await typeAtEnd(firstBlock(), "R");
  const before = tab.source;
  pressKey("r", { metaKey: true }, muya.domNode);
  const modal = await waitFor(() => document.querySelector(".modal-backdrop"));
  check("", "미저장 상태의 ⌘R은 확인 대화상자를 띄운다", !!modal && visible(modal));
  document.querySelector<HTMLElement>(".modal-backdrop .modal-cancel")?.click();
  await waitFor(() => !document.querySelector(".modal-backdrop"));
  check("", "다시 읽기를 취소하면 편집이 그대로다", tab.source === before && tab.dirty, JSON.stringify(tab.source));

  // 5) Muya 안의 링크 클릭은 커서 놓기다 — 브라우저를 열면 안 된다(여는 것은 ⌘-클릭).
  const opens = () => calls().filter((c) => c.cmd === "plugin:opener|open_url").length;
  const anchor = document.createElement("a");
  anchor.href = "https://example.com/x";
  anchor.textContent = "link";
  muya.domNode.appendChild(anchor);
  const opensBefore = opens();
  anchor.click();
  await wait(100);
  anchor.remove();
  check("", "Muya 안의 링크 일반 클릭은 외부 브라우저를 열지 않는다", opens() === opensBefore);

  // 6) Muya의 전역 CSS가 앱 글꼴을 바꾸면 안 된다.
  const body = getComputedStyle(document.body);
  check(
    "",
    "편집 모드 진입 뒤에도 앱 본문 글꼴·줄 높이는 그대로다",
    body.fontFamily.startsWith("-apple-system") && body.lineHeight === "26.4px",
    `${body.fontFamily} / ${body.lineHeight}`,
  );
});

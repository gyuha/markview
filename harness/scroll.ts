// 분할 모드 스크롤 동기화 검증. 실제 index.html 마크업 + 실제 main.ts를 쓴다 —
// `node harness/build-mocked.mjs scroll` 로 페이지를 만들고 브라우저에서 #out 을 읽는다.
import { EditorView } from "@codemirror/view";

const out = document.querySelector<HTMLElement>("#out")!;
const lines: string[] = [];
let fail = 0;

function eq(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  lines.push(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
}
function near(name: string, got: number, want: number, tol: number): void {
  const ok = Math.abs(got - want) <= tol;
  if (!ok) fail++;
  lines.push(`${ok ? "PASS" : "FAIL"}  ${name}  got=${got.toFixed(1)} want=${want.toFixed(1)}±${tol}`);
}

const wait = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
const q = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

/** 원문과 렌더 높이 분포가 어긋나도록 중간에 코드블록을 넣은 긴 문서. */
function buildDoc(): string {
  const parts: string[] = [];
  for (let i = 0; i < 30; i++) {
    parts.push(`## 절 ${i}`, "", `문단 ${i} 내용입니다.`, "");
    if (i === 10) {
      parts.push("```js");
      for (let k = 0; k < 20; k++) parts.push(`const x${k} = ${k};`);
      parts.push("```", "");
    }
  }
  return parts.join("\n");
}

function anchors(): { line: number; tag: string; top: number }[] {
  const preview = q(".preview");
  const base = preview.getBoundingClientRect().top - preview.scrollTop;
  return [...document.querySelectorAll<HTMLElement>(".markdown-body [data-line]")].map((el) => ({
    line: Number(el.dataset.line),
    tag: el.tagName.toLowerCase(),
    top: el.getBoundingClientRect().top - base,
  }));
}

function editorTopLine(view: EditorView): number {
  const height = view.scrollDOM.getBoundingClientRect().top - view.documentTop;
  return view.state.doc.lineAt(view.lineBlockAtHeight(height).from).number - 1;
}

function previewTopLine(): number {
  const preview = q(".preview");
  const top = preview.scrollTop;
  const list = anchors();
  let prev = list[0];
  for (const a of list) {
    if (a.top <= top) { prev = a; continue; }
    const span = a.top - prev.top;
    const frac = span <= 0 ? 0 : (top - prev.top) / span;
    return prev.line + (a.line - prev.line) * frac;
  }
  return prev.line;
}

async function run(): Promise<void> {
  for (let i = 0; i < 60 && !document.querySelector(".pane"); i++) await wait(60);
  if (!document.querySelector(".pane")) { out.textContent = "탭이 열리지 않음"; return; }

  q('#view-mode [data-mode="split"]').click();
  await wait(60);
  const view = EditorView.findFromDOM(q(".editor-host"))!;
  const preview = q(".preview");

  // 긴 문서를 넣는다. onChange → tab.source 갱신 → 250ms 디바운스 후 프리뷰 재렌더.
  const doc = buildDoc();
  const srcLines = doc.split("\n");
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc } });
  await wait(600);

  // 1) 앵커가 원문 줄과 일치하는가
  const list = anchors();
  lines.push(`앵커 ${list.length}개 (태그: ${[...new Set(list.map((a) => a.tag))].join(",")})`);
  const h2 = list.filter((a) => a.tag === "h2");
  eq("h2 앵커 개수", h2.length, 30);
  const bad = h2.filter((a) => srcLines[a.line] !== `## 절 ${h2.indexOf(a)}`);
  eq("h2 앵커의 줄 번호가 원문과 일치", bad.length, 0);
  eq("코드블록(pre)에도 앵커가 있다", list.some((a) => a.tag === "pre"), true);
  eq("프리뷰가 스크롤 가능한 높이", preview.scrollHeight > preview.clientHeight, true);

  // 2) 에디터 → 프리뷰
  const targetLine = srcLines.indexOf("## 절 20");
  view.dispatch({ effects: EditorView.scrollIntoView(view.state.doc.line(targetLine + 1).from, { y: "start" }) });
  await wait(200);
  // 양쪽을 서로 비교하면 안 된다 — 잘못된 위치로 함께 수렴해도 통과한다(변이 시험으로 발견).
  // 기대 줄 번호(진실의 출처)와 비교한다.
  near("에디터→프리뷰: 프리뷰 최상단 줄", previewTopLine(), targetLine, 3);
  near("에디터→프리뷰: 에디터가 되밀리지 않음", editorTopLine(view), targetLine, 3);

  // 3) 프리뷰 → 에디터
  const anchor5 = list.find((a) => a.tag === "h2" && srcLines[a.line] === "## 절 5")!;
  preview.scrollTop = anchor5.top;
  await wait(200);
  near("프리뷰→에디터: 에디터 최상단 줄", editorTopLine(view), anchor5.line, 3);

  // 4) 진동 없음 — 사용자 스크롤 한 번이 되돌아오지 않는다
  let previewEvents = 0;
  let editorEvents = 0;
  const onP = () => { previewEvents++; };
  const onE = () => { editorEvents++; };
  preview.addEventListener("scroll", onP);
  view.scrollDOM.addEventListener("scroll", onE);
  const anchor15 = list.find((a) => a.tag === "h2" && srcLines[a.line] === "## 절 15")!;
  preview.scrollTop = anchor15.top;
  await wait(500);
  preview.removeEventListener("scroll", onP);
  view.scrollDOM.removeEventListener("scroll", onE);
  lines.push(`스크롤 이벤트: 프리뷰=${previewEvents} 에디터=${editorEvents}`);
  eq("진동 없음 (프리뷰 이벤트 1회)", previewEvents, 1);

  // 5) 재렌더 후에도 위치가 유지된다 (기존 결함 수정)
  const beforeLine = previewTopLine();
  const beforeTop = preview.scrollTop;
  view.dispatch({ changes: { from: view.state.doc.length, insert: "\n\n추가 문단\n" } });
  await wait(600);
  lines.push(`재렌더 전 scrollTop=${beforeTop.toFixed(0)} 후=${preview.scrollTop.toFixed(0)}`);
  eq("재렌더 후 맨 위로 튀지 않았다", preview.scrollTop > 10, true);
  near("재렌더 후 기준 줄 유지", previewTopLine(), beforeLine, 3);

  lines.push("", fail === 0 ? "전부 통과" : `실패 ${fail}건`);
  out.textContent = lines.join("\n");
}

void run();

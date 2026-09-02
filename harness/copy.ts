// 코드블록 복사 버튼 검증. 실제 index.html 마크업 + 실제 main.ts를 구동하고 Tauri IPC만 모킹한다 —
// `node harness/build-mocked.mjs copy` 로 페이지를 만들고 브라우저에서 #out 을 읽는다.
//
// 픽스처는 mock-tauri.js의 DOC.text를 건드리지 않고 편집기에 직접 넣는다(scroll 하네스와 같은 방식).
// DOC.text를 바꾸면 그 본문에 기대는 toolbar 하네스가 함께 깨진다.
import { EditorView } from "@codemirror/view";

const out = document.querySelector<HTMLElement>("#out")!;
const lines: string[] = [];
let fail = 0;

function eq(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  lines.push(
    `${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`,
  );
}

const wait = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
const q = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

const TS_CODE = 'const greeting = "안녕";\nconsole.log(greeting);';
const PLAIN_CODE = "just plain text\n  indented line";
const MERMAID_SRC = "graph TD\n  A --> B";

/** 세 종류의 ``` 블록: 언어 있음 · 언어 없음 · mermaid. */
function buildDoc(): string {
  return [
    "# 복사 버튼",
    "",
    "```ts",
    TS_CODE,
    "```",
    "",
    "```",
    PLAIN_CODE,
    "```",
    "",
    "```mermaid",
    MERMAID_SRC,
    "```",
    "",
  ].join("\n");
}

interface MockCall {
  cmd: string;
  args?: { text?: string };
}
const calls = () => (window as unknown as { __TAURI_MOCK_CALLS__: MockCall[] }).__TAURI_MOCK_CALLS__;

function lastClipboardCall(): MockCall | undefined {
  return [...calls()].reverse().find((c) => c.cmd === "plugin:clipboard-manager|write_text");
}

function buttons(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(".markdown-body .copy-btn")];
}

async function run(): Promise<void> {
  for (let i = 0; i < 60 && !document.querySelector(".pane"); i++) await wait(60);
  if (!document.querySelector(".pane")) {
    out.textContent = "탭이 열리지 않음 (모킹 실패)";
    return;
  }

  q('#view-mode [data-mode="split"]').click();
  await wait(60);
  const view = EditorView.findFromDOM(q(".editor-host"))!;

  // onChange → tab.source 갱신 → 250ms 디바운스 후 프리뷰 재렌더.
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: buildDoc() } });
  await wait(700);

  // 1) 어떤 블록에 버튼이 붙었는가
  const pres = [...document.querySelectorAll<HTMLElement>(".markdown-body pre")];
  eq("pre 개수", pres.length, 2);
  eq("버튼 개수 = pre 개수", buttons().length, pres.length);
  eq(
    "언어 있는 블록에 버튼 1개",
    document.querySelectorAll(".markdown-body pre:has(code.language-ts) .copy-btn").length,
    1,
  );
  eq(
    "언어 없는 블록에 버튼 1개",
    [...pres].filter((p) => !p.querySelector("code[class]") && p.querySelector(".copy-btn")).length,
    1,
  );
  // mermaid는 <pre>가 <div class="mermaid-block">으로 치환되므로 버튼이 붙으면 안 된다.
  eq("mermaid 블록 존재", document.querySelectorAll(".mermaid-block").length, 1);
  eq("mermaid 블록에 버튼 0개", document.querySelectorAll(".mermaid-block .copy-btn").length, 0);

  // 2) 평소에는 감춰져 있다 — el.hidden(속성)이 아니라 computed style로 잰다.
  eq("hover 전 버튼은 보이지 않음", getComputedStyle(buttons()[0]).opacity, "0");

  // 3) 클릭 → 클립보드로 그 블록의 원문이 그대로 간다 (하이라이팅 마크업이 섞이면 안 된다)
  buttons()[0].click();
  await wait(60);
  eq("클립보드 호출됨", lastClipboardCall()?.cmd, "plugin:clipboard-manager|write_text");
  eq("복사된 텍스트 = 원문(ts)", lastClipboardCall()?.args?.text, `${TS_CODE}\n`);
  eq("복사 표시가 붙음", buttons()[0].hasAttribute("data-copied"), true);

  buttons()[1].click();
  await wait(60);
  eq("복사된 텍스트 = 원문(언어 없음)", lastClipboardCall()?.args?.text, `${PLAIN_CODE}\n`);

  // 4) 재렌더 후에도 동작하는가 — 버튼에 직접 리스너를 달았다면 여기서 깨진다.
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: buildDoc() } });
  await wait(700);
  eq("재렌더 후 버튼 다시 존재", buttons().length, 2);
  eq("재렌더로 복사 표시는 초기화됨", buttons()[0].hasAttribute("data-copied"), false);
  buttons()[0].click();
  await wait(60);
  eq("재렌더 후 클릭이 동작", lastClipboardCall()?.args?.text, `${TS_CODE}\n`);
  eq("재렌더 후에도 복사 표시가 붙음", buttons()[0].hasAttribute("data-copied"), true);

  lines.push(fail === 0 ? "모두 통과" : `실패 ${fail}건`);
  out.textContent = lines.join("\n");
}

void run();

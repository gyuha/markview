// 편집 모드의 찾기/바꾸기 검색창(F01–F06). 키·입력·클릭은 DOM 이벤트로만 일으키고 판정은 검색창 표시,
// 일치 수 표시(i / N), Muya의 강조 DOM, getMarkdown()으로 한다.
// 기대 개수는 픽스처에서 사람이 센 상수다 — 같은 정규식으로 기대값을 만들면 서로 맞물려 항상 일치한다.
import {
  activeTab,
  check,
  clickMode,
  eq,
  guard,
  injectViaSplit,
  muyaOf,
  ready,
  visible,
  wait,
  waitFor,
} from "./lib-muya";

// "cat": 대소문자 무시 5개(Cat·cat·category의 cat·the cat·CAT), 대소문자 구분 3개, 단어 단위 4개(category 제외).
// "c.t": 정규식이 아니면 0개, 정규식이면 대소문자 무시로 5개.
const FIXTURE = "Cat cat category\n\nthe cat sat\n\nCAT 42 7\n";
const REPLACE_FIXTURE = "cat one\n\ncat two\n\ncat three\n";

function key(target: EventTarget, init: KeyboardEventInit, type: "keydown" | "keyup" = "keydown"): void {
  target.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init }));
}

await guard(async () => {
  if (!(await ready())) return check("", "탭이 열렸다", false);
  const tab = activeTab()!;
  clickMode("edit");
  const muya = await muyaOf(tab);
  if (!muya) return check("", "Muya가 만들어졌다", false);
  const root = muya.domNode;
  const bar = () => document.querySelector<HTMLElement>(".search-bar");
  const input = () => bar()?.querySelector<HTMLInputElement>(".search input") ?? null;
  const result = () => bar()?.querySelector(".search-result")?.textContent?.trim() ?? "";
  const count = () => Number(result().split("/")[1] ?? NaN);
  const highlights = () => root.querySelectorAll(".mu-highlight, .mu-selection").length;

  async function load(doc: string): Promise<Element> {
    injectViaSplit(doc);
    clickMode("edit");
    await wait(250);
    return root.querySelector(".mu-content")!;
  }
  /** 입력창을 비우고 DOM 입력으로 검색어를 친다(원본은 150ms 뒤 검색). */
  async function typeQuery(el: HTMLInputElement, text: string): Promise<void> {
    el.focus();
    el.select();
    document.execCommand("insertText", false, text);
    await wait(350);
  }
  const toggle = async (cls: string) => {
    bar()!.querySelector<HTMLElement>(`.controls .${cls}`)!.click();
    await wait(150);
  };

  // ── F01 ⌘F → 검색창, 입력에 포커스 ─────────────────────────────────────
  const content = await load(FIXTURE);
  key(content, { key: "f", code: "KeyF", metaKey: true });
  await wait(100);
  check("F01", "편집 모드 ⌘F → 검색창이 열리고 검색 입력에 포커스", visible(bar()) && document.activeElement === input(), `visible=${visible(bar())} active=${document.activeElement?.tagName}`);

  // ── F02 검색어 → 일치 수와 강조 ─────────────────────────────────────────
  await typeQuery(input()!, "cat");
  eq("F02", "\"cat\" → 일치 수 표시 1 / 5, 강조 5곳", { result: result(), highlights: highlights() }, { result: "1 / 5", highlights: 5 });

  // ── F03 다음·이전 ──────────────────────────────────────────────────────
  const steps: string[] = [];
  key(input()!, { key: "Enter" }, "keyup");
  await wait(80);
  steps.push(result());
  key(input()!, { key: "g", code: "KeyG", metaKey: true });
  await wait(80);
  steps.push(result());
  key(input()!, { key: "Enter", shiftKey: true }, "keyup");
  await wait(80);
  steps.push(result());
  key(input()!, { key: "g", code: "KeyG", metaKey: true, shiftKey: true });
  await wait(80);
  steps.push(result());
  eq("F03", "Enter·⌘G는 다음, ⇧Enter·⇧⌘G는 이전 (i/N 변화)", steps, ["2 / 5", "3 / 5", "2 / 5", "1 / 5"]);

  // ── F04 토글 ───────────────────────────────────────────────────────────
  const counts: Record<string, number> = {};
  await toggle("is-case-sensitive");
  counts.caseSensitive = count();
  await toggle("is-case-sensitive");
  await toggle("is-whole-word");
  counts.wholeWord = count();
  await toggle("is-whole-word");
  await typeQuery(input()!, "c.t");
  counts.literalDot = count();
  await toggle("is-regex");
  counts.regex = count();
  await toggle("is-regex");
  eq("F04", "대소문자·단어 단위·정규식 토글이 일치 수를 바꾼다", counts, { caseSensitive: 3, wholeWord: 4, literalDot: 0, regex: 5 });

  // ── F06 Esc → 닫힘·강조 제거 ─────────────────────────────────────────────
  // 강조가 있는 상태에서 닫아야 "지웠다"를 볼 수 있다 — F04가 남긴 검색어(c.t, 일치 0)를 바꾼다.
  await typeQuery(input()!, "cat");
  const before = highlights();
  key(document.body, { key: "Escape" }, "keyup");
  await wait(150);
  check("F06", "Esc → 검색창 닫힘, 강조 제거", before === 5 && !visible(bar()) && highlights() === 0, `before=${before} visible=${visible(bar())} highlights=${highlights()}`);

  // ── F05 ⌥⌘F → 바꾸기 ───────────────────────────────────────────────────
  const replaceContent = await load(REPLACE_FIXTURE);
  key(replaceContent, { key: "f", code: "KeyF", metaKey: true, altKey: true });
  await wait(100);
  const replaceRow = bar()?.querySelector<HTMLElement>(".replace") ?? null;
  const replaceOpen = visible(bar()) && visible(replaceRow);
  await typeQuery(input()!, "cat");
  const replaceInput = replaceRow!.querySelector<HTMLInputElement>("input")!;
  await typeQuery(replaceInput, "dog");
  replaceRow!.querySelector<HTMLElement>(".button:not(.right)")!.click(); // 하나 바꾸기
  await waitFor(() => muya.getMarkdown().includes("dog"), 1000);
  const afterSingle = muya.getMarkdown();
  replaceRow!.querySelector<HTMLElement>(".button.right")!.click(); // 모두 바꾸기
  await waitFor(() => !muya.getMarkdown().includes("cat"), 1000);
  const afterAll = muya.getMarkdown();
  eq(
    "F05",
    "⌥⌘F → 바꾸기 입력, 하나 바꾸기·모두 바꾸기가 반영",
    { replaceOpen, afterSingle, afterAll },
    { replaceOpen: true, afterSingle: "dog one\n\ncat two\n\ncat three\n", afterAll: "dog one\n\ndog two\n\ndog three\n" },
  );
  key(document.body, { key: "Escape" }, "keyup");
});

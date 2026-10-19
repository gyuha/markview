// 탭 끌어서 순서 바꾸기 — 실제 DOM 포인터 이벤트(좌표 포함)로만 구동하고 DOM·`tabs`·세션 쓰기로 판정한다.
// `node harness/run.mjs tabdrag` 가 ?files=3 페이지로 돌린다. 선택자 계약: #tabbar > .tab[title=경로] · .tab-close · .tab.dragging
import { activeTab, check, guard, tabs, wait } from "./lib-muya";

const P = (n: number) => (n === 1 ? "/tmp/harness.md" : `/tmp/harness-${n}.md`);
const domPaths = () => [...document.querySelectorAll<HTMLElement>("#tabbar .tab")].map((b) => b.title);
const arrPaths = () => tabs().map((t) => t.path);
const sessionPaths = (): string[] | null => {
  const writes = (window as unknown as { __SESSION_WRITES__: string[] }).__SESSION_WRITES__;
  const last = writes.at(-1);
  return last ? (JSON.parse(last) as { paths: string[] }).paths : null;
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const buttonOf = (path: string) => [...document.querySelectorAll<HTMLElement>("#tabbar .tab")].find((b) => b.title === path)!;
const centerX = (el: Element) => el.getBoundingClientRect().left + el.getBoundingClientRect().width / 2;
/** 탭 안쪽 `ratio` 지점의 x. */
const at = (el: Element, ratio: number) => el.getBoundingClientRect().left + el.getBoundingClientRect().width * ratio;

function ptr(type: string, target: EventTarget, x: number, button = 0): void {
  target.dispatchEvent(
    new PointerEvent(type, { clientX: x, button, buttons: type === "pointerup" ? 0 : 1 << button, pointerId: 1, isPrimary: true, bubbles: true, cancelable: true }),
  );
}
/** `from` 탭을 눌러 x들을 차례로 지나가 놓는다. 놓은 직후(setTimeout 전)에 `afterUp`을 부른다. */
function drag(from: Element, xs: number[], afterUp?: () => void, target: EventTarget = from, button = 0): void {
  ptr("pointerdown", target, centerX(from), button);
  for (const x of xs) ptr("pointermove", document, x, button);
  ptr("pointerup", document, xs.at(-1) ?? centerX(from), button);
  afterUp?.();
}
async function activateTab(path: string): Promise<void> {
  buttonOf(path).click();
  await wait(60);
}
function altDigit(n: number): void {
  (document.activeElement ?? document.body).dispatchEvent(
    new KeyboardEvent("keydown", { key: String(n), code: `Digit${n}`, altKey: true, bubbles: true, cancelable: true }),
  );
}

async function main(): Promise<void> {
  for (let i = 0; i < 100 && tabs().length < 3; i++) await wait(60);
  check("D00", "탭 3개가 열렸다", tabs().length === 3 && same(domPaths(), [P(1), P(2), P(3)]), `dom=${JSON.stringify(domPaths())}`);

  // D01 — 1번 탭을 3번 탭 너머로 끌면 DOM·tabs·세션 순서가 [2,3,1], 끝나면 dragging 클래스가 없다
  const b3 = buttonOf(P(3));
  drag(buttonOf(P(1)), [at(b3, 0.9)]);
  await wait(60);
  const want1 = [P(2), P(3), P(1)];
  check(
    "D01",
    "1번 탭을 3번 탭 너머로 끌어 놓으면 DOM·tabs·세션 순서가 [2,3,1]이고 dragging이 남지 않는다",
    same(domPaths(), want1) && same(arrPaths(), want1) && same(sessionPaths(), want1) && !document.querySelector("#tabbar .dragging"),
    `dom=${JSON.stringify(domPaths())} tabs=${JSON.stringify(arrPaths())} session=${JSON.stringify(sessionPaths())}`,
  );

  // D02 — 순서가 바뀐 뒤 ⌥1이 새 첫 탭(2번 파일)을 활성화한다
  altDigit(1);
  await wait(60);
  check("D02", "순서를 바꾼 뒤 ⌥1은 새 순서의 첫 탭을 활성화한다", activeTab()?.path === P(2), `active=${activeTab()?.path}`);

  // D03 — 왼쪽으로 끌기: 맨 오른쪽(1번 파일)을 맨 왼쪽 너머로
  const first = buttonOf(P(2));
  drag(buttonOf(P(1)), [at(first, 0.1)]);
  await wait(60);
  const want3 = [P(1), P(2), P(3)];
  check("D03", "맨 오른쪽 탭을 왼쪽 끝으로 끌면 순서가 [1,2,3]으로 돌아온다", same(domPaths(), want3) && same(arrPaths(), want3) && same(sessionPaths(), want3), `dom=${JSON.stringify(domPaths())} tabs=${JSON.stringify(arrPaths())}`);

  // D04 — 4px 미만 이동은 끌기가 아니다: 순서 그대로, 클릭은 활성화한다
  await activateTab(P(1));
  const t2 = buttonOf(P(2));
  drag(t2, [centerX(t2) + 3], () => t2.click());
  await wait(60);
  check("D04", "4px 미만 이동 후 놓기는 순서를 바꾸지 않고 클릭으로 탭을 활성화한다", same(domPaths(), want3) && activeTab()?.path === P(2) && !t2.classList.contains("dragging"), `dom=${JSON.stringify(domPaths())} active=${activeTab()?.path}`);

  // D05 — 끌기가 끝난 직후의 click은 무시한다: 활성 탭이 바뀌지 않는다. 한 박자 뒤의 click은 다시 통한다
  await activateTab(P(3));
  const t1 = buttonOf(P(1));
  drag(t1, [at(buttonOf(P(2)), 0.9)], () => t1.click());
  const afterDrag = activeTab()?.path;
  await wait(60);
  t1.click();
  await wait(60);
  check("D05", "끌기 직후 click은 활성 탭을 바꾸지 않고, 그 뒤의 click은 다시 활성화한다", afterDrag === P(3) && activeTab()?.path === P(1), `afterDrag=${afterDrag} later=${activeTab()?.path}`);

  // D06 — × 에서 시작한 누름과 주 버튼이 아닌 버튼은 끌기가 아니다
  const before = domPaths();
  const target = buttonOf(before[0]);
  drag(target, [at(buttonOf(before[2]), 0.9)], undefined, target.querySelector(".tab-close")!);
  await wait(60);
  const afterClose = domPaths();
  drag(buttonOf(before[0]), [at(buttonOf(before[2]), 0.9)], undefined, buttonOf(before[0]), 2);
  await wait(60);
  check("D06", "×에서 시작한 누름과 오른쪽 버튼은 순서를 바꾸지 않는다", same(afterClose, before) && same(domPaths(), before), `afterClose=${JSON.stringify(afterClose)} afterRight=${JSON.stringify(domPaths())}`);
}

void guard(main);

// 탭 끌어서 순서 바꾸기 — 실제 DOM 포인터 이벤트(좌표 포함)로만 구동하고 DOM·`tabs`·세션 쓰기로 판정한다.
// `node harness/run.mjs tabdrag` 가 ?files=3 페이지로 돌린다. 선택자 계약: #tabbar > .tab[title=경로] · .tab-close · .tab.dragging
import { activeTab, check, guard, tabs, wait } from "./lib-muya";

const P = (n: number) => (n === 1 ? "/tmp/harness.md" : `/tmp/harness-${n}.md`);
const domPaths = () => [...document.querySelectorAll<HTMLElement>("#tabbar .tab")].map((b) => b.title);
const arrPaths = () => tabs().map((t) => t.path);
const sessionPaths = (): string[] | null => {
  const writes = (window as unknown as { __SESSION_WRITES__: string[] }).__SESSION_WRITES__;
  const last = writes.at(-1);
  return last ? (JSON.parse(last) as { windows: { main: { paths: string[] } } }).windows.main.paths : null;
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
  // D07 — 끄는 동안 끄는 탭이 커서를 따라 움직인다(시각적 중심 = 커서, 잡은 곳 오프셋 0)
  const lead = buttonOf(domPaths()[0]);
  const x0 = centerX(lead);
  ptr("pointerdown", lead, x0);
  ptr("pointermove", document, x0 + 60);
  const follow = centerX(lead) - (x0 + 60);
  const raised = lead.classList.contains("dragging");
  ptr("pointerup", document, x0 + 60);
  await wait(400);
  check("D07", "끄는 동안 끄는 탭의 중심이 커서를 2px 안으로 따라가고 dragging 표시가 붙는다", Math.abs(follow) <= 2 && raised, `follow=${follow.toFixed(1)} raised=${raised}`);

  // D08 — 이웃 탭과 자리를 바꾸는 순간: 끄는 탭은 여전히 커서 아래, 밀려난 이웃은 전환 중(transform ≠ none)
  const order8 = domPaths();
  const mover = buttonOf(order8[0]);
  const neighbor = buttonOf(order8[1]);
  const mx0 = centerX(mover);
  const aim = at(neighbor, 0.9);
  ptr("pointerdown", mover, mx0);
  ptr("pointermove", document, aim);
  const swapped = domPaths()[0] === order8[1] && domPaths()[1] === order8[0];
  const underCursor = Math.abs(centerX(mover) - aim) <= 2;
  const slideNow = getComputedStyle(neighbor).transform;
  ptr("pointerup", document, aim);
  await wait(400);
  check("D08", "자리를 바꾼 직후에도 끄는 탭은 커서 아래에 있고 밀려난 이웃은 transform 전환 중이다", swapped && underCursor && slideNow !== "none", `swapped=${swapped} underCursor=${underCursor} slide=${slideNow}`);

  // D09 — 탭 바 밖으로 끌어도 끄는 탭은 탭 바 가로 범위 안에 머문다
  const bar = document.querySelector<HTMLElement>("#tabbar")!.getBoundingClientRect();
  const edge = buttonOf(domPaths()[0]);
  ptr("pointerdown", edge, centerX(edge));
  ptr("pointermove", document, bar.right + 500);
  const rightEdge = edge.getBoundingClientRect().right;
  ptr("pointermove", document, bar.left - 500);
  const leftEdge = edge.getBoundingClientRect().left;
  ptr("pointerup", document, bar.left - 500);
  await wait(400);
  check("D09", "탭 바 양쪽 바깥으로 끌어도 끄는 탭이 탭 바 범위 안에 머문다", rightEdge <= bar.right + 0.5 && leftEdge >= bar.left - 0.5, `right=${rightEdge} bar.right=${bar.right} left=${leftEdge} bar.left=${bar.left}`);

  // D10 — 놓고 전환이 끝나면 모든 탭의 인라인 transform·transition이 비고 DOM·tabs·세션 순서가 같다
  const tidy = [...document.querySelectorAll<HTMLElement>("#tabbar .tab")].every((el) => el.style.transform === "" && el.style.transition === "");
  check("D10", "놓고 400ms 뒤에는 모든 탭의 인라인 transform·transition이 비고 순서가 DOM·tabs·세션에서 같다", tidy && same(domPaths(), arrPaths()) && same(domPaths(), sessionPaths()), `tidy=${tidy} dom=${JSON.stringify(domPaths())} tabs=${JSON.stringify(arrPaths())} session=${JSON.stringify(sessionPaths())}`);

}

void guard(main);

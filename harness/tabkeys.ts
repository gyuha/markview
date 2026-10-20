// ⌥+숫자 탭 전환 — 실제 keydown(물리 키 code 포함)으로만 구동하고 활성 탭으로 판정한다.
// `node harness/run.mjs tabkeys` 가 ?files=3 페이지로 돌린다. 같은 키를 보기·분할·편집 전용 세 모드에서 누른다.
import { activeTab, check, clickMode, guard, muyaOf, tabs, wait } from "./lib-muya";

/** 물리 키 code를 함께 실어 보낸다 — macOS의 ⌥+숫자는 key가 기호('¡')로 온다. 취소됐는지(preventDefault)를 돌려준다. */
function press(digit: number, mods: { alt?: boolean; meta?: boolean; shift?: boolean; key?: string } = { alt: true }): boolean {
  const target = document.activeElement ?? document.body;
  return !target.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: mods.key ?? String(digit),
      code: `Digit${digit}`,
      altKey: !!mods.alt,
      metaKey: !!mods.meta,
      shiftKey: !!mods.shift,
      bubbles: true,
      cancelable: true,
    }),
  );
}

const index = () => tabs().findIndex((t) => t === activeTab());
async function goTo(i: number): Promise<void> {
  tabs()[i].button.click();
  await wait(60);
}

async function main(): Promise<void> {
  for (let i = 0; i < 100 && tabs().length < 3; i++) await wait(60);
  check("N00", "탭 3개가 열렸다", tabs().length === 3, `n=${tabs().length}`);

  // N01 — 보기 모드: ⌥1·⌥2·⌥3이 각각 1·2·3번째 탭
  const got: number[] = [];
  for (const n of [3, 1, 2]) {
    press(n);
    await wait(60);
    got.push(index() + 1);
  }
  check("N01", "보기 모드에서 ⌥3·⌥1·⌥2가 각각 3·1·2번째 탭을 활성화한다", JSON.stringify(got) === "[3,1,2]", `got=${JSON.stringify(got)}`);

  // N02 — ⌥9는 마지막 탭
  await goTo(0);
  press(9);
  await wait(60);
  check("N02", "⌥9는 탭 개수와 무관하게 마지막 탭을 활성화한다", index() === 2, `index=${index()}`);

  // N03 — 범위 밖(⌥5)은 활성 탭을 바꾸지 않되 키는 막는다(기호가 입력되지 않게)
  await goTo(1);
  const canceled = press(5);
  await wait(60);
  check("N03", "탭 3개에서 ⌥5는 활성 탭을 바꾸지 않고 기본 동작은 막는다", index() === 1 && canceled, `index=${index()} canceled=${canceled}`);

  // N04 — macOS처럼 key가 기호('¡')여도 code로 판별한다
  await goTo(2);
  press(1, { alt: true, key: "¡" });
  await wait(60);
  check("N04", "key가 '¡'로 와도 물리 키(Digit1)로 첫 탭을 활성화한다", index() === 0, `index=${index()}`);

  // N05 — ⌥ 외 수정자가 함께 있으면 가로채지 않는다
  await goTo(0);
  press(2, { alt: true, shift: true });
  press(3, { alt: true, meta: true });
  press(2, { alt: false });
  await wait(60);
  check("N05", "⇧⌥숫자·⌥⌘숫자·수정자 없는 숫자는 탭을 바꾸지 않는다", index() === 0, `index=${index()}`);

  // N06·N07 — 분할 / 편집 전용 모드에서도 같다(입력 영역에 포커스가 있는 채로)
  for (const [id, mode] of [["N06", "split"], ["N07", "edit"]] as const) {
    await goTo(0);
    clickMode(mode);
    if (mode === "edit") await muyaOf(tabs()[0]);
    await wait(250);
    const seq: number[] = [];
    for (const n of [2, 3, 9]) {
      press(n);
      await wait(60);
      seq.push(index() + 1);
      await goTo(0);
    }
    const stay = press(7) && index() === 0;
    check(id, `${mode} 모드에서 ⌥2·⌥3·⌥9가 2·3·3번째 탭을, ⌥7(범위 밖)은 그대로`, JSON.stringify(seq) === "[2,3,3]" && stay, `seq=${JSON.stringify(seq)} stay=${stay} focus=${document.activeElement?.tagName}`);
  }

  // N08 — 편집 전용 모드의 ⌘1(제목 단축키)은 탭을 바꾸지 않는다
  await goTo(0);
  clickMode("edit");
  await muyaOf(tabs()[0]);
  await wait(250);
  press(1, { meta: true });
  await wait(60);
  check("N08", "편집 전용 모드의 ⌘1은 탭을 바꾸지 않는다(제목 단축키 유지)", index() === 0, `index=${index()}`);

  // N09~N13 — 탭이 많아 탭바가 넘칠 때, ⌥숫자로 활성화한 탭은 탭바 가시 영역 안으로 들어온다.
  // 탭 3개를 그대로 쓰되 #tabbar를 첫 탭 너비의 1.5배로 좁혀 오버플로를 만든다(첫 탭만 온전히 보인다).
  const bar = document.querySelector<HTMLElement>("#tabbar")!;
  const w0 = tabs()[0].button.getBoundingClientRect().width;
  bar.style.flex = "0 0 auto";
  bar.style.width = `${Math.round(w0 * 1.5)}px`;
  await wait(60);
  const overflow = bar.scrollWidth > bar.clientWidth;
  check("N09", "탭바를 좁히면 가로 오버플로가 생긴다(이후 단정의 전제)", overflow, `scrollWidth=${bar.scrollWidth} clientWidth=${bar.clientWidth}`);

  const fullyIn = (el: HTMLElement): boolean => {
    const b = bar.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return r.left >= b.left - 1 && r.right <= b.right + 1;
  };
  /** src 탭에서 목표 탭이 가시 영역 밖이 되도록 스크롤해 둔 뒤 ⌥n을 누르고 [사전 가시 여부, 사후 가시 여부, 활성 탭 번호]를 돌려준다. */
  async function scenario(mode: "view" | "split" | "edit", n: number, src: number): Promise<[boolean, boolean, number]> {
    await goTo(src);
    clickMode(mode);
    if (mode === "edit") await muyaOf(tabs()[src]);
    await wait(250);
    const want = n === 9 ? tabs().length - 1 : n - 1;
    bar.scrollLeft = want > src ? 0 : bar.scrollWidth;
    await wait(60);
    const before = fullyIn(tabs()[want].button);
    press(n);
    await wait(120);
    return [before, fullyIn(tabs()[want].button), index()];
  }
  const verdict = (r: [boolean, boolean, number], want: number) => !r[0] && r[1] && r[2] === want;

  const a = await scenario("view", 1, 2);
  check("N10", "보기 모드: 오른쪽 끝에서 ⌥1을 누르면 화면 밖 첫 탭이 탭바 안으로 들어온다", verdict(a, 0), `before=${a[0]} after=${a[1]} index=${a[2]}`);
  const b = await scenario("view", 3, 0);
  const c = await scenario("view", 9, 0);
  check("N11", "보기 모드: 첫 탭에서 ⌥3·⌥9를 누르면 화면 밖 마지막 탭이 탭바 안으로 들어온다", verdict(b, 2) && verdict(c, 2), `⌥3=${b} ⌥9=${c}`);
  const d = await scenario("view", 2, 0);
  check("N12", "보기 모드: 일부만 보이는 중간 탭(⌥2)도 탭바 안으로 완전히 들어온다", verdict(d, 1), `before=${d[0]} after=${d[1]} index=${d[2]}`);
  const e = await scenario("split", 1, 2);
  const f = await scenario("split", 3, 0);
  check("N13", "분할 모드: ⌥1·⌥3으로 화면 밖 탭이 탭바 안으로 들어온다", verdict(e, 0) && verdict(f, 2), `⌥1=${e} ⌥3=${f}`);
  const g = await scenario("edit", 1, 2);
  const h = await scenario("edit", 3, 0);
  check("N14", "편집 전용 모드: ⌥1·⌥3으로 화면 밖 탭이 탭바 안으로 들어온다", verdict(g, 0) && verdict(h, 2), `⌥1=${g} ⌥3=${h}`);
}

void guard(main);

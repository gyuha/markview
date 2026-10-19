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
}

void guard(main);

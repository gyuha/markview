// 항상 위 버튼 — 실제 DOM 이벤트(클릭·포커스)로 구동하고 DOM과 모킹 IPC 호출 기록으로만 판정한다.
// `node harness/run.mjs ontop` 이 ?files=3 페이지로 돌린다. T05는 같은 앱을 iframe으로 하나 더 띄워 "다른 창"으로 쓴다.
// 계약: `#toolbar-right [data-ontop]` 버튼 · `aria-pressed` · IPC `set_always_on_top` 인자 `{ enabled: boolean }` · 오류는 `#notice`.
import { calls, check, clickMode, guard, ready, respond, tabs, visible, wait, waitFor } from "./lib-muya";

const params = new URLSearchParams(location.search);

type Call = { cmd: string; args?: Record<string, unknown> };
type Mode = "ok" | "fail" | "slow";
let mode: Mode = "ok";

const ONTOP = "set_always_on_top";
const buttonOf = (doc: Document = document) => doc.querySelector<HTMLElement>("#toolbar-right [data-ontop]");
const pressed = (b: HTMLElement | null) => b?.getAttribute("aria-pressed");
const ontopCalls = (list: Call[] = calls() as Call[]) => list.filter((c) => c.cmd === ONTOP);
const enabledOf = (c: Call | undefined) => c?.args?.enabled;
const errors: string[] = [];
window.addEventListener("error", (e) => errors.push(String(e.message)));
window.addEventListener("unhandledrejection", (e) => errors.push(String(e.reason)));

/** 지금 상태가 want가 아니면 한 번 눌러 맞춘다(성공 모드에서만). */
async function setOnTop(b: HTMLElement, want: boolean): Promise<void> {
  if ((pressed(b) === "true") === want) return;
  b.click();
  await waitFor(() => (pressed(b) === "true") === want, 2000);
}

async function main(): Promise<void> {
  // 자식 창(iframe)은 앱만 띄우고 검사는 하지 않는다.
  if (params.has("child")) return;

  await ready();
  respond(ONTOP, () => {
    if (mode === "fail") throw "창을 고정할 수 없습니다";
    if (mode === "slow") return wait(150).then(() => null);
    return null;
  });
  const b = buttonOf();

  // T04 — 시작·파일 열기·설정 열기·탭 전환만으로는 호출이 없다(맨 먼저 잰다).
  document.querySelector<HTMLElement>("#settings-button")?.click();
  await wait(150);
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await wait(150);
  for (const t of tabs()) {
    t.button.click();
    await wait(60);
  }
  check("T04", "시작·파일 열기·설정 열기·탭 전환만으로는 `set_always_on_top`이 불리지 않는다", ontopCalls().length === 0, `calls=${ontopCalls().length}`);

  // T01
  const inRight = b?.closest("#toolbar-right") !== null && document.querySelectorAll("#toolbar-right [data-ontop]").length === 1;
  check(
    "T01",
    "`#toolbar-right` 안에 `[data-ontop]` 버튼이 하나 있고 `aria-pressed`가 false이며 이름이 있다",
    !!b && inRight && pressed(b) === "false" && !!b.getAttribute("aria-label")?.trim() && !!b.getAttribute("title")?.trim(),
    `exists=${!!b} inRight=${inRight} pressed=${pressed(b ?? null)}`,
  );
  if (!b) return;

  // T02
  const base = ontopCalls().length;
  b.click();
  await waitFor(() => pressed(b) === "true", 2000);
  const afterOn = ontopCalls().slice(base);
  b.click();
  await waitFor(() => pressed(b) === "false", 2000);
  const afterOff = ontopCalls().slice(base);
  check(
    "T02",
    "누르면 `{ enabled: true }`로 1번, 다시 누르면 `{ enabled: false }`로 1번 불리고 `aria-pressed`가 따라간다",
    afterOn.length === 1 && enabledOf(afterOn[0]) === true && afterOff.length === 2 && enabledOf(afterOff[1]) === false && pressed(b) === "false",
    `on=${JSON.stringify(afterOn.map(enabledOf))} all=${JSON.stringify(afterOff.map(enabledOf))} pressed=${pressed(b)}`,
  );

  // T03 — 거부되면 누르기 전 값으로 돌아오고 #notice에 이유가 보인다.
  await setOnTop(b, false);
  const before3 = pressed(b);
  mode = "fail";
  const notice = document.querySelector<HTMLElement>("#notice");
  const errBefore = errors.length;
  b.click();
  await wait(200);
  const rolledBack = pressed(b) === before3 && before3 === "false";
  const noticeShown = !!notice && !notice.hidden && visible(notice) && (notice.textContent ?? "").trim().length > 0;
  mode = "ok";
  check("T03", "IPC가 거부되면 `aria-pressed`가 이전 값으로 돌아오고 `#notice`에 이유가 보이며 페이지 오류가 없다", rolledBack && noticeShown && errors.length === errBefore, `rolledBack=${rolledBack} notice=${noticeShown} errors=${errors.length - errBefore}`);
  if (notice) notice.hidden = true;

  // T05 — 서로 다른 창: 이 창만 켜도 다른 창은 꺼진 채이고 그 창의 IPC는 0번이다.
  const frame = document.createElement("iframe");
  frame.style.cssText = "position:fixed;left:-2000px;top:0;width:900px;height:600px";
  frame.src = `${location.pathname}?files=1&child=1`;
  document.body.append(frame);
  const other = await waitFor(() => {
    const doc = frame.contentDocument;
    return doc && doc.querySelector(".pane") && buttonOf(doc) ? frame.contentWindow : null;
  }, 15000);
  let t05 = false;
  let t05Detail = "자식 창이 뜨지 않음";
  if (other) {
    const ob = buttonOf(other.document)!;
    const otherCalls = () => ontopCalls((other as unknown as { __TAURI_MOCK_CALLS__: Call[] }).__TAURI_MOCK_CALLS__);
    const mineBefore = ontopCalls().length;
    await setOnTop(b, true);
    await wait(150);
    const mine = ontopCalls().slice(mineBefore);
    t05 = pressed(b) === "true" && mine.length === 1 && enabledOf(mine[0]) === true && pressed(ob) === "false" && otherCalls().length === 0;
    t05Detail = `mine=${pressed(b)}/${JSON.stringify(mine.map(enabledOf))} other=${pressed(ob)}/${otherCalls().length}`;
    await setOnTop(b, false);
  }
  check("T05", "한 창의 버튼만 켜면 그 창의 IPC만 불리고 다른 창은 `aria-pressed`가 false이며 IPC가 0번이다", t05, t05Detail);
  frame.remove();

  // T06 — IPC가 느려도 연타 뒤 화면과 마지막 IPC 값이 같다.
  mode = "slow";
  const base6 = ontopCalls().length;
  b.click();
  b.click();
  await wait(500);
  const made = ontopCalls().slice(base6);
  const lastEnabled = enabledOf(made[made.length - 1]);
  mode = "ok";
  check("T06", "버튼을 빠르게 두 번 눌러도 마지막 `aria-pressed`가 마지막 IPC의 `enabled`와 같다", made.length >= 1 && String(lastEnabled) === pressed(b), `calls=${JSON.stringify(made.map(enabledOf))} pressed=${pressed(b)}`);
  await setOnTop(b, false);

  // T07 — 켜 둔 상태는 탭 전환·보기 모드·테마 전환으로 바뀌지 않고 추가 호출도 없다.
  await setOnTop(b, true);
  const base7 = ontopCalls().length;
  for (const t of tabs()) {
    t.button.click();
    await wait(60);
  }
  for (const m of ["view", "split", "edit", "split"] as const) {
    clickMode(m);
    await wait(120);
  }
  for (const c of ["dark", "light", "system"]) {
    document.querySelector<HTMLElement>(`#theme [data-choice="${c}"]`)?.click();
    await wait(80);
  }
  check("T07", "켜진 상태가 탭 전환·보기 모드·테마 전환으로 바뀌지 않고 그동안 추가 호출이 없다", pressed(b) === "true" && ontopCalls().length === base7, `pressed=${pressed(b)} extra=${ontopCalls().length - base7}`);

  // T08 — 네이티브 버튼이라 키보드로 닿는다(합성 키 이벤트는 버튼을 누르지 못하므로 실제 키 입력은 사람 확인 C7에서 본다).
  b.focus();
  const nativeButton = b.tagName === "BUTTON" && b.getAttribute("type") === "button";
  const reachable = !(b as HTMLButtonElement).disabled && b.tabIndex >= 0 && document.activeElement === b;
  check("T08", "버튼은 네이티브 `<button type=\"button\">`이고 비활성이 아니며 포커스를 받을 수 있다", nativeButton && reachable, `tag=${b.tagName} type=${b.getAttribute("type")} disabled=${(b as HTMLButtonElement).disabled} tabIndex=${b.tabIndex} focused=${document.activeElement === b}`);
  await setOnTop(b, false);

  // T09 — 켜진 상태와 꺼진 상태가 눈으로 구별된다(두 테마 모두).
  const look = () => {
    const s = getComputedStyle(b);
    return `${s.color}|${s.backgroundColor}|${s.borderTopColor}`;
  };
  const distinct: boolean[] = [];
  for (const c of ["light", "dark"]) {
    document.querySelector<HTMLElement>(`#theme [data-choice="${c}"]`)?.click();
    await wait(120);
    await setOnTop(b, false);
    const off = look();
    await setOnTop(b, true);
    const on = look();
    distinct.push(on.split("|")[0] !== off.split("|")[0] || on.split("|")[1] !== off.split("|")[1]);
    await setOnTop(b, false);
  }
  check("T09", "켜진 상태와 꺼진 상태에서 계산된 글자색 또는 배경색이 다르고 라이트·다크 모두 유지된다", distinct.length === 2 && distinct.every(Boolean), `distinct=${JSON.stringify(distinct)}`);
}

void guard(main);

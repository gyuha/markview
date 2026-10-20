// 다중 창·탭 분리 — W01~W04는 순수 판정(dropAction), W05~W14는 이후 슬라이스에서 채운다.
// `node harness/run.mjs windows` 가 ?files=3 페이지로 돌린다.
import { check, guard, tabs, wait } from "./lib-muya";
import { dropAction } from "../src/tabDetach";

const TH = 40;
const bar = { left: 0, right: 800, top: 0, bottom: 36 };
const W = 800;
const act = (x: number, y: number) => dropAction({ x, y }, bar, W, TH);

// 탭 끌기 — 실제 DOM 포인터 이벤트(좌표 포함)로 구동한다. 판정은 DOM·mock 호출 기록으로 한다.
const P = (n: number) => (n === 1 ? "/tmp/harness.md" : `/tmp/harness-${n}.md`);
const domPaths = () => [...document.querySelectorAll<HTMLElement>("#tabbar .tab")].map((b) => b.title);
const buttonOf = (path: string) => [...document.querySelectorAll<HTMLElement>("#tabbar .tab")].find((b) => b.title === path)!;
const centerX = (el: Element) => el.getBoundingClientRect().left + el.getBoundingClientRect().width / 2;
const barMidY = () => {
  const r = document.querySelector("#tabbar")!.getBoundingClientRect();
  return (r.top + r.bottom) / 2;
};
const farY = () => document.querySelector("#tabbar")!.getBoundingClientRect().bottom + 200;
function ptr(type: string, target: EventTarget, x: number, y: number): void {
  target.dispatchEvent(
    new PointerEvent(type, { clientX: x, clientY: y, screenX: x + 100, screenY: y + 50, button: 0, buttons: type === "pointerup" ? 0 : 1, pointerId: 1, isPrimary: true, bubbles: true, cancelable: true }),
  );
}
type Pt = [number, number];
/** `from` 탭을 눌러 점들을 차례로 지나가 놓는다. */
function drag(from: Element, pts: Pt[]): void {
  ptr("pointerdown", from, centerX(from), barMidY());
  for (const [x, y] of pts) ptr("pointermove", document, x, y);
  const [x, y] = pts.at(-1)!;
  ptr("pointerup", document, x, y);
}

async function newWindow(): Promise<void> {
  // W10 — 분리로 만든 새 창은 take_window_init이 준 경로만 열고, 저장된 세션(x·y)과 take_pending_files(files=2)는 건드리지 않는다.
  const w = window as unknown as { __TAURI_MOCK_CALLS__: { cmd: string; args?: { path?: string } }[] };
  const INIT = "/tmp/harness-init.md";
  for (let i = 0; i < 100 && tabs().length < 1; i++) await wait(60);
  await wait(300);
  const paths = tabs().map((t) => t.path);
  const onlyInit = paths.length === 1 && paths[0] === INIT;
  const pending = w.__TAURI_MOCK_CALLS__.some((c) => c.cmd === "take_pending_files");
  const readOthers = w.__TAURI_MOCK_CALLS__.some((c) => c.cmd === "read_markdown" && c.args?.path !== INIT);
  check("W10", "새 창(`take_window_init`이 경로를 돌려줌)은 그 경로만 열고 지난 세션 복원을 하지 않는다", onlyInit && !pending && !readOthers, `paths=${JSON.stringify(paths)} pending=${pending} readOthers=${readOthers}`);
}

async function main(): Promise<void> {
  if (new URLSearchParams(location.search).has("windowInit")) return newWindow();
  check("W01", "놓은 지점이 탭바 안(위·아래 40px 이내)이면 순서 바꾸기로 판정한다", act(400, 18) === "reorder" && act(400, bar.top - 39) === "reorder" && act(400, bar.bottom + 39) === "reorder", `inside=${act(400, 18)} up=${act(400, -39)} down=${act(400, 75)}`);
  check("W02", "탭바 위·아래로 40px을 넘으면 분리로 판정한다", act(400, bar.top - 41) === "detach" && act(400, bar.bottom + 41) === "detach", `up=${act(400, -41)} down=${act(400, 77)}`);
  check("W03", "창 가로 범위 밖이면 탭바 높이여도 분리로 판정한다", act(-1, 18) === "detach" && act(W + 1, 18) === "detach" && act(0, 18) === "reorder" && act(W, 18) === "reorder", `left=${act(-1, 18)} right=${act(W + 1, 18)}`);
  const edges = [act(400, bar.top - TH), act(400, bar.top - TH), act(400, bar.bottom + TH), act(400, bar.bottom + TH)];
  check("W04", "경계값(정확히 임계)에서 판정이 흔들리지 않는다", edges.every((a) => a === "reorder") && act(400, bar.top - TH - 0.01) === "detach" && act(400, bar.bottom + TH + 0.01) === "detach", `edges=${JSON.stringify(edges)}`);

  // W09 — 다른 창이 쥔 파일은 claim_file이 거절하므로 읽지도, 탭을 만들지도 않는다. 같은 창 요청은 통과한다.
  const w = window as unknown as { __OTHER_OWNED__: string[]; __PICK_MARKDOWN__: string | null; __TAURI_MOCK_CALLS__: { cmd: string; args?: { path?: string } }[] };
  const calls = () => w.__TAURI_MOCK_CALLS__;
  const OWNED = "/tmp/harness-owned.md";
  const FREE = "/tmp/harness-free.md";
  const pick = async (path: string) => {
    w.__PICK_MARKDOWN__ = path;
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "o", code: "KeyO", metaKey: true, bubbles: true, cancelable: true }));
    await wait(250);
  };
  for (let i = 0; i < 100 && tabs().length < 3; i++) await wait(60);
  const before = tabs().length;
  w.__OTHER_OWNED__ = [OWNED];
  await pick(OWNED);
  const refused = tabs().length === before && !tabs().some((t) => t.path === OWNED);
  const claimed = calls().some((c) => c.cmd === "claim_file" && c.args?.path === OWNED);
  const readOwned = calls().some((c) => c.cmd === "read_markdown" && c.args?.path === OWNED);
  await pick(FREE);
  const opened = tabs().some((t) => t.path === FREE);
  check("W09", "`claim_file`이 \"다른 창 소유\"를 돌려주면 탭을 만들지 않는다", refused && claimed && !readOwned && opened, `refused=${refused} claimed=${claimed} readOwned=${readOwned} freeOpened=${opened}`);

  type Call = { cmd: string; args?: Record<string, unknown> };
  const mc = () => w.__TAURI_MOCK_CALLS__ as unknown as Call[];
  const cmds = (name: string) => mc().filter((c) => c.cmd === name);
  const lastSession = () => (JSON.parse((window as unknown as { __SESSION_WRITES__: string[] }).__SESSION_WRITES__.at(-1) ?? "{}") as { windows?: { main?: { paths: string[] } } }).windows?.main?.paths ?? null;
  const tabOf = (path: string) => tabs().find((t) => t.path === path)!;
  const modal = (sel: string) => document.querySelector<HTMLElement>(sel);

  // W14 — 분리 배선 뒤에도 탭바 안 순서 바꾸기(D01)와 4px 미만 클릭(D04)이 그대로다
  const count14 = tabs().length;
  const reorderY = barMidY();
  drag(buttonOf(P(1)), [[centerX(buttonOf(P(3))) + 20, reorderY]]);
  await wait(60);
  const reordered = JSON.stringify(domPaths().slice(0, 3)) === JSON.stringify([P(2), P(3), P(1)]) && JSON.stringify(tabs().map((t) => t.path)) === JSON.stringify(domPaths()) && !document.querySelector("#tabbar .dragging");
  const t2 = buttonOf(P(2));
  const detachesBefore = cmds("detach_tab").length;
  ptr("pointerdown", t2, centerX(t2), reorderY);
  ptr("pointermove", document, centerX(t2) + 3, reorderY);
  ptr("pointerup", document, centerX(t2) + 3, reorderY);
  t2.click();
  await wait(60);
  check("W14", "기존 같은 탭바 순서 바꾸기(D01)와 4px 미만 클릭(D04)이 분리 배선 뒤에도 그대로 동작한다", reordered && tabs().length === count14 && cmds("detach_tab").length === detachesBefore && !t2.classList.contains("detach-ready"), `reordered=${reordered} dom=${JSON.stringify(domPaths())}`);

  // W05 — 임계를 넘은 끄는 탭에만 .detach-ready, 되돌아오면 떨어진다
  const b1 = buttonOf(P(1));
  ptr("pointerdown", b1, centerX(b1), reorderY);
  ptr("pointermove", document, centerX(b1) + 10, reorderY);
  const inside = b1.classList.contains("detach-ready");
  ptr("pointermove", document, centerX(b1) + 10, farY());
  const outside = b1.classList.contains("detach-ready");
  const others = [...document.querySelectorAll("#tabbar .tab")].filter((b) => b !== b1 && b.classList.contains("detach-ready")).length;
  ptr("pointermove", document, centerX(b1) + 10, reorderY);
  const back = b1.classList.contains("detach-ready");
  ptr("pointerup", document, centerX(b1) + 10, reorderY);
  check("W05", "분리 임계를 넘은 끄는 탭에만 `.detach-ready`가 붙고 되돌아오면 떨어진다", !inside && outside && others === 0 && !back && !b1.classList.contains("detach-ready"), `inside=${inside} out=${outside} others=${others} back=${back}`);
  await wait(60);

  // W06 — 미저장 탭을 분리로 놓으면 확인창이 먼저 뜨고, 취소하면 detach_tab이 불리지 않고 탭이 제자리다
  tabOf(P(1)).dirty = true;
  const n06 = cmds("detach_tab").length;
  const order06 = JSON.stringify(domPaths());
  drag(buttonOf(P(1)), [[centerX(buttonOf(P(1))) + 10, farY()]]);
  const shown = !!modal(".modal-backdrop") && !!modal(".modal-confirm") && modal(".modal-confirm")!.textContent === "저장하고 옮기기";
  const callsAtAsk = cmds("detach_tab").length - n06;
  modal(".modal-cancel")?.click();
  await wait(120);
  check("W06", "분리 놓기에서 미저장 탭이면 확인창이 먼저 뜨고, 취소하면 `detach_tab`이 불리지 않고 탭이 제자리다", shown && callsAtAsk === 0 && cmds("detach_tab").length === n06 && !!tabs().find((t) => t.path === P(1)) && !modal(".modal-backdrop"), `shown=${shown} callsAtAsk=${callsAtAsk} order=${order06}->${JSON.stringify(domPaths())}`);

  // W07·W08(성공) — 확인하면 저장이 먼저 불리고 그 뒤 detach_tab이 경로·화면 좌표와 함께 불린다. 성공하면 확인 없이 탭이 닫힌다
  const n07 = mc().length;
  const b1b = buttonOf(P(1));
  const dropX = centerX(b1b) + 10;
  const dropY = farY();
  drag(b1b, [[dropX, dropY]]);
  modal(".modal-confirm")?.click();
  await wait(200);
  const seq = mc().slice(n07).map((c) => c.cmd);
  const iw = seq.indexOf("write_markdown");
  const id = seq.indexOf("detach_tab");
  const dc = cmds("detach_tab").at(-1)?.args;
  check("W07", "확인(저장하고 옮기기)이면 저장이 먼저 불리고 그 뒤 `detach_tab`이 경로·화면 좌표와 함께 불린다", iw >= 0 && id > iw && dc?.path === P(1) && dc?.fromLabel === "main" && dc?.screenX === dropX + 100 && dc?.screenY === dropY + 50, `seq=${JSON.stringify(seq)} args=${JSON.stringify(dc)}`);
  const gone = !tabs().some((t) => t.path === P(1)) && !domPaths().includes(P(1)) && !modal(".modal-backdrop") && !(lastSession() ?? [P(1)]).includes(P(1));
  // 실패 — 클린 탭을 분리하려는데 detach_tab이 거절하면 탭이 남는다
  (window as unknown as { __DETACH_FAIL__: boolean }).__DETACH_FAIL__ = true;
  const failPath = tabs()[0].path;
  drag(buttonOf(failPath), [[centerX(buttonOf(failPath)) + 10, farY()]]);
  await wait(200);
  const kept = tabs().some((t) => t.path === failPath) && domPaths().includes(failPath);
  check("W08", "`detach_tab` 성공 시 탭이 이 창에서 사라지고 세션이 갱신되며, 실패 시 탭이 남는다", gone && kept, `gone=${gone} kept=${kept} session=${JSON.stringify(lastSession())}`);

  // W11~W13 — 다른 창이 저장소를 바꾸면 storage 이벤트로 이 창이 다시 적용한다 (최근 파일은 대상이 아님)
  const root = document.documentElement;
  const storage = async (key: string, value: string | null) => {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
    window.dispatchEvent(new StorageEvent("storage", { key, newValue: value, storageArea: localStorage }));
    await wait(200);
  };
  await storage("markview.theme", "light");
  const bgLight = root.style.getPropertyValue("--bg");
  await storage("markview.theme", "dark");
  const themeBtn = document.querySelector('#theme [data-choice="dark"]');
  check("W11", "`storage` 이벤트(`markview.theme`)가 오면 선택 테마가 다시 적용된다", root.dataset.theme === "dark" && root.style.getPropertyValue("--bg") !== bgLight && themeBtn?.getAttribute("aria-checked") === "true", `theme=${root.dataset.theme} btn=${themeBtn?.getAttribute("aria-checked")}`);
  const bgBefore = root.style.getPropertyValue("--bg");
  await storage("markview.theme.dark", "dracula-default");
  const bgAfter = root.style.getPropertyValue("--bg");
  check("W12", "`storage` 이벤트(색상 테마 키)가 오면 색상 테마가 다시 적용된다", root.dataset.theme === "dark" && bgAfter !== bgBefore, `before=${bgBefore} after=${bgAfter}`);
  await storage("markview.docWidth", "wide");
  const wide = root.style.getPropertyValue("--doc-width");
  await storage("markview.recent", JSON.stringify(["/tmp/x.md"]));
  const stable = root.style.getPropertyValue("--doc-width") === wide && root.dataset.theme === "dark";
  check("W13", "`storage` 이벤트(문서 너비 키)가 오면 `--doc-width`가 바뀐다", wide === "64rem" && stable, `width=${wide} stable=${stable}`);
}

void guard(main);

// 최근 파일 다이얼로그 — 실제 DOM 이벤트(키 입력·클릭)로만 구동하고 DOM으로만 판정한다.
// `node harness/run.mjs recent` 가 ?files=3 · ?files=25 · ?files=0 세 페이지로 돌린다.
// 선택자 계약: .modal-backdrop > [role=dialog] · input[type=search] · [role=option][data-path][aria-selected]
//              · .recent-name · .recent-dir · .recent-empty
const out = document.querySelector<HTMLElement>("#out")!;
const lines: string[] = [];
const params = new URLSearchParams(location.search);
const files = Number(params.get("files") ?? 1);

const wait = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

function check(id: string, label: string, ok: boolean, detail = ""): void {
  lines.push(`${ok ? "PASS" : "FAIL"}  [${id}] ${label}${ok ? "" : `  ${detail}`}`);
  out.textContent = lines.join("\n");
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

interface HTab {
  path: string;
  mode: string;
  pane: HTMLElement;
  button: HTMLElement;
}
const tabsOf = (win: Window = window) => (win as unknown as { __MARKVIEW_TABS__: HTab[] }).__MARKVIEW_TABS__;
const activeTabPath = () => tabsOf().find((t) => !t.pane.hidden)?.path ?? null;

function key(win: Window, k: string, mods: { meta?: boolean; ctrl?: boolean } = {}, target?: EventTarget): void {
  const Ctor = (win as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent;
  const t = target ?? (win.document.activeElement as EventTarget | null) ?? win.document.body;
  t.dispatchEvent(new Ctor("keydown", { key: k, metaKey: !!mods.meta, ctrlKey: !!mods.ctrl, bubbles: true, cancelable: true }));
}
const dialogOf = (doc: Document = document) => doc.querySelector<HTMLElement>('.modal-backdrop [role="dialog"]');
const inputOf = (doc: Document = document) => dialogOf(doc)?.querySelector<HTMLInputElement>('input[type="search"]') ?? null;
const optionsOf = (doc: Document = document) =>
  [...(dialogOf(doc)?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
const pathsOf = (doc: Document = document) => optionsOf(doc).map((o) => o.dataset.path);
const selectedOf = (doc: Document = document) => optionsOf(doc).findIndex((o) => o.getAttribute("aria-selected") === "true");

async function openDialog(mods: { meta?: boolean; ctrl?: boolean } = { meta: true }): Promise<HTMLElement | null> {
  key(window, "o", mods, document.body);
  await wait(80);
  return dialogOf();
}
async function type(q: string): Promise<void> {
  const input = inputOf()!;
  input.value = q;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await wait(60);
}
async function closeDialog(): Promise<void> {
  if (dialogOf()) {
    key(window, "Escape");
    await wait(60);
  }
}
const mockCalls = () => (window as unknown as { __TAURI_MOCK_CALLS__: { cmd: string; args?: { path?: string } }[] }).__TAURI_MOCK_CALLS__;

async function ready(): Promise<void> {
  for (let i = 0; i < 100 && document.querySelectorAll(".pane").length < files; i++) await wait(60);
  await wait(300);
}

async function main(): Promise<void> {
  await ready();
  const P = (n: number) => (n === 1 ? "/tmp/harness.md" : `/tmp/harness-${n}.md`);

  if (files === 0) {
    const d = await openDialog();
    check("R12", "기록이 없으면 빈 상태 문구를 보인다", !!d && optionsOf().length === 0 && !!d.querySelector(".recent-empty"), `dialog=${!!d} options=${optionsOf().length}`);
    return;
  }

  if (files === 25) {
    const d = await openDialog();
    const got = pathsOf();
    const want = Array.from({ length: 20 }, (_, i) => P(25 - i));
    check("R04", "목록은 최대 20개이고 가장 오래된 것부터 빠진다", !!d && same(got, want), `n=${got.length} first=${got[0]} last=${got.at(-1)}`);
    return;
  }

  // files === 3
  // R01
  let d = await openDialog();
  const input = inputOf();
  check("R01", "⌘O로 role=dialog가 열리고 검색창에 포커스", !!d && !!input && document.activeElement === input, `dialog=${!!d} focus=${document.activeElement?.tagName}`);
  await closeDialog();
  d = await openDialog({ ctrl: true });
  check("R01", "Ctrl+O도 같다", !!d && document.activeElement === inputOf(), `dialog=${!!d}`);

  // R02
  const opts = optionsOf();
  const names = opts.map((o) => o.querySelector(".recent-name")?.textContent);
  const dirs = opts.map((o) => o.querySelector(".recent-dir")?.textContent ?? "");
  check(
    "R02",
    "C·B·A 최근 순, 파일명과 폴더 경로 표시",
    same(pathsOf(), [P(3), P(2), P(1)]) &&
      same(names, ["harness-3.md", "harness-2.md", "harness.md"]) &&
      dirs.every((x) => x.includes("/tmp")),
    `paths=${JSON.stringify(pathsOf())} names=${JSON.stringify(names)} dirs=${JSON.stringify(dirs)}`,
  );

  // R05
  await type("HARNESS-2");
  check("R05", "대소문자 구분 없는 파일명 부분 문자열", same(pathsOf(), [P(2)]), JSON.stringify(pathsOf()));
  await type("harness");
  check("R05", "공통 부분 문자열은 셋 다 남는다", pathsOf().length === 3, JSON.stringify(pathsOf()));

  // R06
  await type("TMP");
  check("R06", "폴더 경로에도 맞는다", pathsOf().length === 3, JSON.stringify(pathsOf()));
  await type("tmp 3");
  check("R06", "공백 구분 여러 단어는 AND", same(pathsOf(), [P(3)]), JSON.stringify(pathsOf()));
  await type("tmp zzz");
  check("R06", "한 단어라도 안 맞으면 제외", pathsOf().length === 0, JSON.stringify(pathsOf()));

  // R07 — 일치 없음
  await type("nomatch-xyz");
  const before = mockCalls().length;
  const beforeActive = activeTabPath();
  key(window, "Enter");
  await wait(120);
  check(
    "R07",
    "빈 상태 문구를 보이고 Enter는 아무것도 열지 않는다",
    !!dialogOf()?.querySelector(".recent-empty") && mockCalls().length === before && activeTabPath() === beforeActive,
    `empty=${!!dialogOf()?.querySelector(".recent-empty")} calls=${mockCalls().length - before} active=${activeTabPath()}`,
  );

  // R08
  await type("");
  const first = selectedOf();
  key(window, "ArrowDown");
  await wait(40);
  const afterDown = selectedOf();
  key(window, "ArrowDown");
  await wait(40);
  const afterDown2 = selectedOf();
  key(window, "ArrowUp");
  await wait(40);
  const afterUp = selectedOf();
  key(window, "Enter");
  await wait(150);
  check(
    "R08",
    "첫 항목 기본 강조 · ↓/↑ 이동 · Enter는 강조 항목 탭 활성화",
    first === 0 && afterDown === 1 && afterDown2 === 2 && afterUp === 1 && !dialogOf() && activeTabPath() === P(2),
    `first=${first} down=${afterDown} down2=${afterDown2} up=${afterUp} dialog=${!!dialogOf()} active=${activeTabPath()}`,
  );

  // R03 — 방금 P(2)를 열었으니 맨 위, 중복 없음
  await openDialog();
  check("R03", "다시 연 경로가 맨 위로 올라가고 중복이 없다", same(pathsOf(), [P(2), P(3), P(1)]), JSON.stringify(pathsOf()));

  // R10 — Esc
  const callsBeforeEsc = mockCalls().length;
  const activeBeforeEsc = activeTabPath();
  key(window, "Escape");
  await wait(80);
  const escOk = !dialogOf() && mockCalls().length === callsBeforeEsc && activeTabPath() === activeBeforeEsc;
  await openDialog();
  dialogOf()!.parentElement!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await wait(80);
  check("R10", "Esc와 배경 클릭은 열지 않고 DOM에서 제거", escOk && !dialogOf() && activeTabPath() === activeBeforeEsc, `esc=${escOk} dialogAfterBackdrop=${!!dialogOf()}`);

  // R13 — 열린 동안 ⌘E 무시, 닫으면 동작
  const tab0 = tabsOf().find((t) => !t.pane.hidden)!;
  const modeBefore = tab0.mode;
  await openDialog();
  key(window, "e", { meta: true });
  await wait(80);
  const modeWhileOpen = tab0.mode;
  await closeDialog();
  key(window, "e", { meta: true }, document.body);
  await wait(120);
  check("R13", "열린 동안 ⌘E 무시, 닫으면 다시 동작", modeWhileOpen === modeBefore && tab0.mode !== modeBefore, `before=${modeBefore} open=${modeWhileOpen} after=${tab0.mode}`);

  // R09 — 닫아 둔 파일을 클릭으로 연다
  const t3 = tabsOf().find((t) => t.path === P(3))!;
  t3.button.querySelector<HTMLElement>(".tab-close")!.click();
  await wait(150);
  const closed = !tabsOf().some((t) => t.path === P(3));
  await openDialog();
  const target = optionsOf().find((o) => o.dataset.path === P(3));
  const readsBefore = mockCalls().filter((c) => c.cmd === "read_markdown" && c.args?.path === P(3)).length;
  target?.click();
  await wait(200);
  const readsAfter = mockCalls().filter((c) => c.cmd === "read_markdown" && c.args?.path === P(3)).length;
  check(
    "R09",
    "닫아 둔 파일 항목 클릭 → read_markdown 호출, 탭 재생성",
    closed && !!target && readsAfter === readsBefore + 1 && tabsOf().some((t) => t.path === P(3)) && !dialogOf(),
    `closed=${closed} target=${!!target} reads=${readsBefore}->${readsAfter}`,
  );

  // R11 — 같은 출처의 새 문서(iframe, 시작 시 파일 없음)에서도 같은 목록
  await openDialog();
  const expected = pathsOf();
  await closeDialog();
  const frame = document.createElement("iframe");
  frame.style.cssText = "width:600px;height:400px";
  frame.src = `${location.pathname}?files=0&child=1`;
  document.body.appendChild(frame);
  await new Promise((r) => frame.addEventListener("load", r, { once: true }));
  await wait(600);
  const cw = frame.contentWindow!;
  key(cw, "o", { meta: true }, cw.document.body);
  await wait(120);
  check("R11", "새로 읽은 문서에서도 목록이 유지된다", expected.length === 3 && same(pathsOf(cw.document), expected), `want=${JSON.stringify(expected)} got=${JSON.stringify(pathsOf(cw.document))}`);
}

if (!params.has("child")) {
  void main()
    .catch((e) => check("ERR", `하네스 예외: ${e}`, false))
    .finally(() => {
      lines.push("DONE");
      out.textContent = lines.join("\n");
    });
}

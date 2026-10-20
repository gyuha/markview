// 세션 복원·설정 탭 — 실제 DOM 이벤트(클릭·키 입력)로 구동하고 DOM과 localStorage로만 판정한다.
// `node harness/run.mjs session` 이 쿼리가 다른 다섯 페이지로 돌린다(run.mjs의 specs 참고).
// 선택자 계약: .settings [role=tablist] > [role=tab] · [role=tabpanel] · [role=switch](aria-checked)
//              · .tab-close · #empty · #notice
const out = document.querySelector<HTMLElement>("#out")!;
const lines: string[] = [];
const params = new URLSearchParams(location.search);

const wait = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

function check(id: string, label: string, ok: boolean, detail = ""): void {
  lines.push(`${ok ? "PASS" : "FAIL"}  [${id}] ${label}${ok ? "" : `  ${detail}`}`);
  out.textContent = lines.join("\n");
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

interface HTab {
  path: string;
  pane: HTMLElement;
  button: HTMLElement;
}
// 앱이 DOMContentLoaded 안에서 심는 전역이라 처음엔 없을 수 있다.
const tabsOf = () => (window as unknown as { __MARKVIEW_TABS__?: HTab[] }).__MARKVIEW_TABS__ ?? [];
const pathsOfTabs = () => tabsOf().map((t) => t.path);
const activeOf = () => tabsOf().find((t) => !t.pane.hidden)?.path ?? null;
const session = () => JSON.parse(localStorage.getItem("markview.session") ?? "null");
// 세션은 창 라벨별 목록({windows:{main,…}})이다. 이 하네스의 창 라벨은 main. 항목이 없으면 null.
const mainOf = (raw: unknown = session()) => (raw as { windows?: Record<string, unknown> } | null)?.windows?.main ?? null;
const otherOf = () => (session() as { windows?: Record<string, unknown> } | null)?.windows?.w2 ?? null;
const writes = () => (window as unknown as { __SESSION_WRITES__: string[] }).__SESSION_WRITES__;
const closeButton = (t: HTab) => t.button.querySelector<HTMLElement>(".tab-close")!;

async function waitFor(cond: () => boolean, ms = 6000): Promise<void> {
  for (let t = 0; t < ms && !cond(); t += 60) await wait(60);
  await wait(300);
}

const H1 = "/tmp/harness.md";
const H2 = "/tmp/harness-2.md";
const H3 = "/tmp/harness-3.md";

async function pageOpenedTabs(): Promise<void> {
  await waitFor(() => tabsOf().length === 3);

  // S01 — 열고 · 전환하고 · 닫을 때마다 즉시 기록된다.
  const rawOpen = session();
  const afterOpen = mainOf(rawOpen);
  tabsOf()[0].button.click();
  await wait(100);
  const afterSwitch = mainOf();
  closeButton(tabsOf()[1]).click();
  await wait(150);
  const afterClose = mainOf();
  check(
    "S01",
    "탭을 열고·전환하고·닫으면 markview.session에 경로·순서·활성 탭이 즉시 기록된다",
    same(afterOpen, { paths: [H1, H2, H3], active: H3 }) &&
      same(afterSwitch, { paths: [H1, H2, H3], active: H1 }) &&
      same(afterClose, { paths: [H1, H3], active: H1 }),
    `open=${JSON.stringify(afterOpen)} switch=${JSON.stringify(afterSwitch)} close=${JSON.stringify(afterClose)}`,
  );

  // S10 — 저장 형식은 창 라벨별 목록이다(옛 최상위 paths·active는 남지 않는다).
  check(
    "S10",
    "세션은 {windows:{main:{paths,active}}} 창 라벨별 목록으로 기록된다",
    same(rawOpen, { windows: { main: { paths: [H1, H2, H3], active: H3 } } }),
    `raw=${JSON.stringify(rawOpen)}`,
  );

  // S07 — 설정 다이얼로그는 "모양"·"환경" 두 탭이고 처음엔 "모양".
  document.querySelector<HTMLElement>("#settings-button")!.click();
  await wait(100);
  const dialog = document.querySelector<HTMLElement>(".settings");
  const tabs = [...(dialog?.querySelectorAll<HTMLElement>('[role="tablist"] [role="tab"]') ?? [])];
  const panels = [...(dialog?.querySelectorAll<HTMLElement>('[role="tabpanel"]') ?? [])];
  const visible = () => panels.filter((p) => !p.hidden);
  const labelsOk = same(tabs.map((t) => t.textContent?.trim()), ["모양", "환경"]);
  const startsOnLook = tabs[0]?.getAttribute("aria-selected") === "true" && tabs[1]?.getAttribute("aria-selected") === "false";
  const lookPanel = visible()[0];
  const lookHasControls =
    !!lookPanel?.querySelector("[data-mode-choice]") && !!lookPanel?.querySelector('[data-color-kind="light"] .cs-trigger');
  tabs[0]?.focus();
  tabs[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
  await wait(80);
  const envPanel = visible()[0];
  const afterRight = tabs[1]?.getAttribute("aria-selected") === "true" && visible().length === 1;
  const envHasSwitch = !!envPanel?.querySelector('[role="switch"]');
  tabs[1]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
  await wait(80);
  const backToLook = tabs[0]?.getAttribute("aria-selected") === "true";
  check(
    "S07",
    '설정 다이얼로그는 "모양"·"환경" 탭이고 처음엔 "모양", ←/→로 전환되며 "모양"에 기존 컨트롤·"환경"에 토글이 있다',
    !!dialog && labelsOk && startsOnLook && lookHasControls && afterRight && envHasSwitch && backToLook && panels.length === 2,
    `labels=${labelsOk} startsOnLook=${startsOnLook} lookControls=${lookHasControls} right=${afterRight} switch=${envHasSwitch} left=${backToLook} panels=${panels.length}`,
  );

  // S08 — 토글은 기본 켬, 클릭하면 저장값이 바뀌고, 꺼도 세션 기록은 계속된다.
  tabs[1]?.click();
  await wait(60);
  const sw = dialog?.querySelector<HTMLElement>('[role="switch"]') ?? null;
  const defaultOn = sw?.getAttribute("aria-checked") === "true";
  sw?.click();
  await wait(80);
  const storedOff = localStorage.getItem("markview.restoreSession");
  const switchOff = sw?.getAttribute("aria-checked") === "false";
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await wait(80);
  tabsOf()[1]?.button.click();
  await wait(100);
  check(
    "S08",
    "환경 토글은 기본 켬이고 클릭하면 markview.restoreSession이 바뀌며, 꺼도 세션 기록은 계속된다",
    defaultOn && storedOff === "false" && switchOff && same(mainOf(), { paths: [H1, H3], active: H3 }),
    `defaultOn=${defaultOn} stored=${storedOff} switchOff=${switchOff} session=${JSON.stringify(session())}`,
  );

  // S09 — 모든 탭을 닫으면 세션이 빈 목록으로 기록된다.
  for (const t of [...tabsOf()]) {
    closeButton(t).click();
    await wait(120);
  }
  check("S09", "모든 탭을 닫으면 이 창의 세션 항목이 비어 있다(항목 없음)", mainOf() === null, `session=${JSON.stringify(session())}`);
}

// 다른 창(w2) 항목이 심어진 채 이 창(main)만 열고 닫는다.
async function pageMulti(): Promise<void> {
  await waitFor(() => tabsOf().length === 2);
  const w2 = { paths: ["/tmp/o.md"], active: "/tmp/o.md" };
  check(
    "S13",
    "이 창이 세션을 쓸 때 다른 창 라벨의 항목은 그대로 남는다",
    same(mainOf(), { paths: [H1, H2], active: H2 }) && same(otherOf(), w2),
    `session=${JSON.stringify(session())}`,
  );
  closeButton(tabsOf()[0]).click();
  await wait(150);
  const afterOne = mainOf();
  closeButton(tabsOf()[0]).click();
  await wait(150);
  check(
    "S12",
    "마지막 탭을 직접 닫으면 이 창 항목만 제거되고 다른 창 항목은 남는다",
    same(afterOne, { paths: [H2], active: H2 }) && mainOf() === null && same(otherOf(), w2),
    `afterOne=${JSON.stringify(afterOne)} session=${JSON.stringify(session())}`,
  );
}

const callsOf = (cmd: string) =>
  (window as unknown as { __TAURI_MOCK_CALLS__: { cmd: string; args: unknown }[] }).__TAURI_MOCK_CALLS__.filter((c) => c.cmd === cmd);
const emitTauri = (event: string) => (window as unknown as { __emitTauri: (e: string) => void }).__emitTauri(event);

// 다른 창(w2) 항목이 심긴 채 요청 없이 시작한다 — 메인 창은 w2를 되살리게 하고, 닫는 경로별로 항목이 남는지 본다.
async function pageCloseWindow(): Promise<void> {
  await waitFor(() => tabsOf().length === 1);
  const restored = callsOf("restore_windows");
  check(
    "S02",
    "메인 창은 시작할 때 main이 아닌 저장된 창 항목마다 Rust에 창 복원을 요청한다",
    restored.length === 1 && same((restored[0].args as { windows: unknown }).windows, [{ label: "w2", path: "/tmp/o.md" }]),
    `calls=${JSON.stringify(restored)}`,
  );
  // 앱 종료(⌘Q)는 닫기 요청 없이 창이 사라진다 — 그 경로에서는 어떤 항목도 지우지 않는다.
  window.dispatchEvent(new Event("pagehide"));
  await wait(150);
  check(
    "S13",
    "앱 종료 경로(닫기 요청 없이 끝남)는 모든 창 항목을 남긴다",
    same(mainOf(), { paths: ["/tmp/a.md"], active: "/tmp/a.md" }) && !!otherOf(),
    `session=${JSON.stringify(session())}`,
  );
  // 창 닫기 버튼(close-requested)이 통과하면 이 창 항목만 지워진다.
  emitTauri("close-requested");
  await waitFor(() => mainOf() === null);
  check(
    "S12",
    "창 닫기 요청을 통과시키면 이 창 항목만 제거되고 다른 창 항목은 남는다",
    mainOf() === null && same(otherOf(), { paths: ["/tmp/o.md"], active: "/tmp/o.md" }) && callsOf("allow_close").length === 1,
    `session=${JSON.stringify(session())} allow_close=${callsOf("allow_close").length}`,
  );
}

// 옛 단일 값 {paths, active}을 심고 시작한다.
async function pageLegacy(): Promise<void> {
  await waitFor(() => tabsOf().length === 3);
  const raw = session() as { paths?: unknown; windows?: unknown } | null;
  check(
    "S11",
    "옛 단일 값 {paths,active}은 main 창의 세션으로 읽혀 그대로 복원된다",
    same(pathsOfTabs(), ["/tmp/a.md", "/tmp/b.md", "/tmp/c.md"]) && activeOf() === "/tmp/b.md",
    `tabs=${JSON.stringify(pathsOfTabs())} active=${activeOf()}`,
  );
  check(
    "S14",
    "옛 값으로 복원한 뒤 다음 기록은 새 형식이다(최상위 paths 없이 windows.main)",
    !!raw && raw.paths === undefined && same(mainOf(raw), { paths: ["/tmp/a.md", "/tmp/b.md", "/tmp/c.md"], active: "/tmp/b.md" }),
    `session=${JSON.stringify(raw)}`,
  );
}

async function pageRestore(): Promise<void> {
  await waitFor(() => tabsOf().length === 3);
  const expected = { paths: ["/tmp/a.md", "/tmp/b.md", "/tmp/c.md"], active: "/tmp/b.md" };
  check(
    "S02",
    "요청 없이 시작하면 저장된 순서대로 탭이 열리고 저장된 활성 탭이 활성이다",
    same(pathsOfTabs(), expected.paths) && activeOf() === expected.active,
    `tabs=${JSON.stringify(pathsOfTabs())} active=${activeOf()}`,
  );
  check(
    "S06",
    "복원이 끝나기 전에는 세션을 쓰지 않는다(복원 전체에서 쓰기 1회, 끝난 뒤 열린 탭과 일치)",
    writes().length === 1 && same(mainOf(JSON.parse(writes()[0] ?? "null")), expected),
    `writes=${writes().length} first=${writes()[0]}`,
  );
}

async function pageToggleOff(): Promise<void> {
  await wait(1500);
  const notice = document.querySelector<HTMLElement>("#empty");
  check(
    "S03",
    "토글이 꺼져 있으면 복원하지 않고 빈 화면이다",
    tabsOf().length === 0 && !!notice && !notice.hidden && same(mainOf(), { paths: ["/tmp/a.md", "/tmp/b.md"], active: null }),
    `tabs=${tabsOf().length} emptyVisible=${!!notice && !notice.hidden} session=${JSON.stringify(session())}`,
  );
}

async function pageRequested(): Promise<void> {
  await waitFor(() => tabsOf().length === 2);
  check(
    "S04",
    "시작 시 요청된 파일이 있으면 복원하지 않고 요청된 파일만 열린다",
    same(pathsOfTabs(), [H1, H2]),
    `tabs=${JSON.stringify(pathsOfTabs())}`,
  );
}

async function pageMissing(): Promise<void> {
  await waitFor(() => tabsOf().length === 2);
  const notice = document.querySelector<HTMLElement>("#notice");
  const recent = JSON.parse(localStorage.getItem("markview.recent") ?? "null");
  check(
    "S05",
    "복원 중 못 여는 파일은 알림 없이 건너뛰고 나머지가 열리며 최근 파일 목록은 그대로다",
    same(pathsOfTabs(), ["/tmp/a.md", "/tmp/c.md"]) &&
      (!notice || notice.hidden || (notice.textContent ?? "").trim() === "") &&
      same(recent, ["/tmp/r1.md", "/tmp/r2.md"]),
    `tabs=${JSON.stringify(pathsOfTabs())} notice=${notice?.textContent} hidden=${notice?.hidden} recent=${JSON.stringify(recent)}`,
  );
}

async function main(): Promise<void> {
  const files = Number(params.get("files") ?? 1);
  if (params.has("closeWin")) return pageCloseWindow();
  if (params.has("seedOther")) return pageMulti();
  if (params.has("seedLegacy")) return pageLegacy();
  if (params.has("restore")) return pageToggleOff();
  if (params.has("missing")) return pageMissing();
  if (params.has("seedSession") && files === 0) return pageRestore();
  if (params.has("seedSession")) return pageRequested();
  return pageOpenedTabs();
}

void main()
  .catch((e) => check("ERR", `하네스 예외: ${e}`, false))
  .finally(() => {
    lines.push("DONE");
    out.textContent = lines.join("\n");
  });

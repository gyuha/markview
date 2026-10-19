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
  const afterOpen = session();
  tabsOf()[0].button.click();
  await wait(100);
  const afterSwitch = session();
  closeButton(tabsOf()[1]).click();
  await wait(150);
  const afterClose = session();
  check(
    "S01",
    "탭을 열고·전환하고·닫으면 markview.session에 경로·순서·활성 탭이 즉시 기록된다",
    same(afterOpen, { paths: [H1, H2, H3], active: H3 }) &&
      same(afterSwitch, { paths: [H1, H2, H3], active: H1 }) &&
      same(afterClose, { paths: [H1, H3], active: H1 }),
    `open=${JSON.stringify(afterOpen)} switch=${JSON.stringify(afterSwitch)} close=${JSON.stringify(afterClose)}`,
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
    defaultOn && storedOff === "false" && switchOff && same(session(), { paths: [H1, H3], active: H3 }),
    `defaultOn=${defaultOn} stored=${storedOff} switchOff=${switchOff} session=${JSON.stringify(session())}`,
  );

  // S09 — 모든 탭을 닫으면 세션이 빈 목록으로 기록된다.
  for (const t of [...tabsOf()]) {
    closeButton(t).click();
    await wait(120);
  }
  check("S09", "모든 탭을 닫으면 세션이 빈 목록으로 기록된다", same(session(), { paths: [], active: null }), `session=${JSON.stringify(session())}`);
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
    writes().length === 1 && same(JSON.parse(writes()[0] ?? "null"), expected),
    `writes=${writes().length} first=${writes()[0]}`,
  );
}

async function pageToggleOff(): Promise<void> {
  await wait(1500);
  const notice = document.querySelector<HTMLElement>("#empty");
  check(
    "S03",
    "토글이 꺼져 있으면 복원하지 않고 빈 화면이다",
    tabsOf().length === 0 && !!notice && !notice.hidden && same(session(), { paths: ["/tmp/a.md", "/tmp/b.md"], active: null }),
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

// 네이티브 테마 호출의 형태와 순서 검증 (ADR 260824-224840).
// `node harness/build-mocked.mjs theme` 로 페이지를 만들고 브라우저에서 #out 을 읽는다.
declare global {
  interface Window {
    __TAURI_MOCK_CALLS__: { cmd: string; args: unknown; domTheme: string | null }[];
  }
}

const out = document.querySelector<HTMLElement>("#out")!;
const lines: string[] = [];
let fail = 0;

function eq(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  lines.push(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
}

/** set_theme 호출만 골라낸다. value가 넘긴 인자, domTheme이 그 시점의 CSS 상태다. */
function themeCalls() {
  return window.__TAURI_MOCK_CALLS__.filter((c) => c.cmd === "plugin:window|set_theme").map(
    (c) => ({ value: (c.args as { value?: string | null }).value ?? null, domTheme: c.domTheme }),
  );
}

const settle = () => new Promise((r) => window.setTimeout(r, 60));
const pick = (choice: string) =>
  document.querySelector<HTMLElement>(`#theme [data-choice="${choice}"]`)!.click();

async function run(): Promise<void> {
  // main.ts의 시작 처리가 끝날 때까지 기다린다.
  for (let i = 0; i < 60 && !document.querySelector(".pane"); i++) await settle();
  if (!document.querySelector(".pane")) {
    out.textContent = "탭이 열리지 않음 (모킹 실패)";
    return;
  }
  await settle();

  // 시작 상태: 저장값을 비웠으므로 선택 테마는 system이다.
  const start = themeCalls();
  eq("시작 시 system → 강제하지 않는다 (null)", start.at(-1)?.value, null);
  const osTheme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  eq("시작 시 실효 테마가 OS를 따른다", document.documentElement.dataset.theme, osTheme);

  pick("light");
  await settle();
  eq("라이트 → 구체값", themeCalls().at(-1)?.value, "light");
  eq("  실효 테마", document.documentElement.dataset.theme, "light");

  pick("dark");
  await settle();
  eq("다크 → 구체값", themeCalls().at(-1)?.value, "dark");
  // 호출 시점에 CSS가 아직 이전 값이면 네이티브가 먼저 적용된 것이다.
  eq("  네이티브가 CSS보다 먼저", themeCalls().at(-1)?.domTheme, "light");
  eq("  실효 테마", document.documentElement.dataset.theme, "dark");

  pick("system");
  await settle();
  eq("시스템 → null (강제 해제)", themeCalls().at(-1)?.value, null);
  eq("  네이티브가 CSS보다 먼저", themeCalls().at(-1)?.domTheme, "dark");
  eq("  실효 테마가 OS를 따른다", document.documentElement.dataset.theme, osTheme);

  lines.push("", `set_theme 호출 순서: ${JSON.stringify(themeCalls().map((c) => c.value))}`);
  lines.push(fail === 0 ? "전부 통과" : `실패 ${fail}건`);
  out.textContent = lines.join("\n");
}

void run();

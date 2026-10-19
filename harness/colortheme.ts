// 색상 테마(ADR 261019-134956)와 설정 다이얼로그 검증.
// `node harness/run.mjs colortheme` 가 Chromium·WebKit 에서 연다. 끝나면 마지막 줄에 DONE 을 쓴다.
import { COLOR_THEMES } from "../src/themes.generated";
import { readColorTheme } from "../src/theme";

declare global {
  interface Window {
    __TAURI_MOCK_CALLS__: { cmd: string; args: unknown; domTheme: string | null }[];
  }
}

const out = document.querySelector<HTMLElement>("#out")!;
const lines: string[] = [];

function eq(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  lines.push(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
}

const theme = (id: string) => COLOR_THEMES.find((t) => t.id === id)!;
const settle = (ms = 80) => new Promise((r) => window.setTimeout(r, ms));
const rootVar = (name: string) => document.documentElement.style.getPropertyValue(name).trim();
const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel);
const nativeCalls = () =>
  window.__TAURI_MOCK_CALLS__
    .filter((c) => c.cmd === "plugin:window|set_theme")
    .map((c) => ({ value: (c.args as { value?: string | null }).value ?? null, domTheme: c.domTheme }));

const openDialog = async () => {
  $<HTMLElement>("#settings-button")!.click();
  await settle();
};
const trigger = (kind: string) => $<HTMLElement>(`.settings [data-color-kind="${kind}"] .cs-trigger`)!;
const options = (kind: string) =>
  [...document.querySelectorAll<HTMLElement>(`.settings [data-color-kind="${kind}"] [role="option"]`)];
const choose = async (kind: string, id: string) => {
  trigger(kind).click();
  await settle();
  document
    .querySelector<HTMLElement>(`.settings [data-color-kind="${kind}"] [role="option"][data-id="${id}"]`)!
    .click();
  await settle();
};
const pressEsc = () =>
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));

async function run(): Promise<void> {
  for (let i = 0; i < 60 && !document.querySelector(".pane"); i++) await settle();
  if (!document.querySelector(".pane")) {
    out.textContent = "탭이 열리지 않음 (모킹 실패)\nDONE";
    return;
  }
  await settle();
  const osTheme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";

  // --- 기본값 ---
  const base = theme(osTheme === "dark" ? "github-dark" : "github-light");
  eq("저장값이 없으면 라이트용 기본은 github-light", readColorTheme("light"), "github-light");
  eq("저장값이 없으면 다크용 기본은 github-dark", readColorTheme("dark"), "github-dark");
  eq("시작 시 실효 테마의 기본 색상 테마가 칠해진다", rootVar("--bg"), base.background);

  // --- 저장값 방어 ---
  localStorage.setItem("markview.theme.dark", "solarized-light"); // 종류가 다른 id
  eq("종류가 다른 저장값은 기본값으로 떨어진다", readColorTheme("dark"), "github-dark");
  localStorage.setItem("markview.theme.light", "없는-테마");
  eq("목록에 없는 저장값은 기본값으로 떨어진다", readColorTheme("light"), "github-light");
  localStorage.removeItem("markview.theme.dark");
  localStorage.removeItem("markview.theme.light");

  // --- 다이얼로그 열기 ---
  eq("다이얼로그는 처음에 없다", $(".settings"), null);
  await openDialog();
  eq("⚙ 버튼으로 다이얼로그가 열린다", $(".settings")?.getAttribute("role"), "dialog");
  eq("모드 라디오에서 시스템이 켜져 있다", $(".settings [data-mode-choice='system']")?.getAttribute("aria-checked"), "true");

  // --- 목록 구성: 종류별로 갈라 보여 준다 ---
  trigger("light").click();
  await settle();
  eq("라이트용 목록은 light 32개", options("light").length, 32);
  eq("  전부 light 종류", options("light").every((o) => theme(o.dataset.id!).kind === "light"), true);
  pressEsc(); // 목록만 닫히고 다이얼로그는 남는다
  await settle();
  eq("목록이 열려 있을 때 Esc는 목록만 닫는다", [options("light").length, !!$(".settings")], [0, true]);
  trigger("dark").click();
  await settle();
  eq("다크용 목록은 dark 80개", options("dark").length, 80);
  pressEsc();
  await settle();

  // --- 색상 테마 고르기: 즉시 반영 + 저장 ---
  await choose("light", "solarized-light");
  eq("라이트용 선택이 저장된다", localStorage.getItem("markview.theme.light"), "solarized-light");
  eq("라이트용을 고르면 (실효가 라이트일 때) 바로 칠해진다", osTheme === "light" ? rootVar("--bg") : "skip", osTheme === "light" ? theme("solarized-light").background : "skip");
  await choose("dark", "dracula-default");
  eq("다크용 선택이 저장된다", localStorage.getItem("markview.theme.dark"), "dracula-default");
  eq("  라이트용 저장값은 그대로", localStorage.getItem("markview.theme.light"), "solarized-light");

  // --- 모드 동기화 + 선택 테마별로 쓰는 쪽이 갈린다 ---
  $<HTMLElement>(".settings [data-mode-choice='dark']")!.click();
  await settle();
  eq("다이얼로그에서 다크를 고르면 툴바 라디오도 다크", $("#theme [data-choice='dark']")?.getAttribute("aria-checked"), "true");
  eq("  다이얼로그 라디오도 다크", $(".settings [data-mode-choice='dark']")?.getAttribute("aria-checked"), "true");
  eq("  실효 테마", document.documentElement.dataset.theme, "dark");
  eq("  다크용 색상 테마가 칠해진다", rootVar("--bg"), theme("dracula-default").background);
  eq("  네이티브는 구체값", nativeCalls().at(-1)?.value, "dark");

  $<HTMLElement>(".settings [data-mode-choice='light']")!.click();
  await settle();
  eq("라이트를 고르면 라이트용 색상 테마가 칠해진다", rootVar("--bg"), theme("solarized-light").background);

  $<HTMLElement>(".settings [data-mode-choice='dark']")!.click();
  await settle();
  $<HTMLElement>(".settings [data-mode-choice='system']")!.click();
  await settle();
  eq("시스템 → 네이티브 강제 해제 (ADR 260824-224840)", nativeCalls().at(-1)?.value, null);
  eq("  네이티브가 CSS보다 먼저 (호출 시점엔 이전 값)", nativeCalls().at(-1)?.domTheme, "dark");
  const sysTheme = theme(osTheme === "dark" ? "dracula-default" : "solarized-light");
  eq("  시스템 모드는 OS 외관의 쪽 색상 테마를 쓴다", rootVar("--bg"), sysTheme.background);

  // --- 라이트 전용으로 만들지 않는 변수가 이전 테마 값으로 남지 않는다 ---
  $<HTMLElement>(".settings [data-mode-choice='dark']")!.click();
  await settle();
  const darkOnly = rootVar("--button-bg-color");
  $<HTMLElement>(".settings [data-mode-choice='light']")!.click();
  await settle();
  eq("다크에서만 만드는 변수는 라이트로 오면 지워진다", [darkOnly !== "", rootVar("--button-bg-color")], [true, ""]);

  // --- 닫기 ---
  pressEsc();
  await settle();
  eq("Esc로 다이얼로그가 닫힌다", $(".settings"), null);

  // --- mermaid: 색상 테마가 바뀌면 다시 그린다 ---
  const svg = () => $(".mermaid-block svg")?.outerHTML.toLowerCase() ?? "";
  for (let i = 0; i < 40 && !svg(); i++) await settle(250);
  eq("mermaid 가 그려져 있다", svg().length > 0, true);
  await openDialog();
  $<HTMLElement>(".settings [data-mode-choice='dark']")!.click();
  for (let i = 0; i < 40 && !svg().includes(theme("dracula-default").normal.blue); i++) await settle(250);
  eq("모드를 바꾸면 그 쪽 색상 테마의 파랑으로 다시 그려진다", svg().includes(theme("dracula-default").normal.blue), true);
  await choose("dark", "gruvbox-dark");
  for (let i = 0; i < 40 && !svg().includes(theme("gruvbox-dark").normal.blue); i++) await settle(250);
  eq("색상 테마를 바꾸면 mermaid 가 새 테마의 파랑으로 다시 그려진다", svg().includes(theme("gruvbox-dark").normal.blue), true);
  pressEsc();

  const fails = lines.filter((l) => l.startsWith("FAIL")).length;
  lines.push("", fails === 0 ? "전부 통과" : `실패 ${fails}건`, "DONE");
  out.textContent = lines.join("\n");
}

void run();

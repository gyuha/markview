import { getCurrentWindow } from "@tauri-apps/api/window";
import { ALL_VAR_NAMES, deriveColors, type Derived } from "./themeColors";
import { COLOR_THEMES, type ThemeKind } from "./themes.generated";

/** 사용자가 고른 값. 저장되는 것은 이것이다. */
export type Choice = "light" | "dark" | "system";
/** 실제로 화면에 적용되는 값. system일 때 OS 상태에서 유도된다. */
export type Effective = "light" | "dark";

/** 실효 테마에 맞는 색상 테마가 계산된 결과 — 화면에 실제로 칠해지는 색 묶음이다. */
export type Palette = Derived;

const STORAGE_KEY = "markview.theme";
const CHOICES: Choice[] = ["light", "dark", "system"];
/** 색상 테마는 실효 테마별로 하나씩 저장한다 (ADR 261019-134956). */
const COLOR_KEY: Record<ThemeKind, string> = {
  light: "markview.theme.light",
  dark: "markview.theme.dark",
};
export const DEFAULT_COLOR_THEME: Record<ThemeKind, string> = {
  light: "github-light",
  dark: "github-dark",
};

let hljsStyleEl: HTMLStyleElement | null = null;
const derivedCache = new Map<string, Palette>();

/**
 * highlight.js 토큰 색. 정적 CSS 두 벌 대신 --tok-* 변수를 읽어서 색상 테마가 바뀌어도
 * 이 문자열은 그대로이고, 변수만 applyChrome이 갈아끼운다.
 */
const HLJS_CSS = `
.hljs { color: var(--fg); background: var(--code-bg); }
.hljs-doctag, .hljs-keyword, .hljs-template-tag, .hljs-template-variable, .hljs-type,
.hljs-variable.language_ { color: var(--tok-keyword); }
.hljs-title, .hljs-title.class_, .hljs-title.function_, .hljs-section { color: var(--tok-func); }
.hljs-attr, .hljs-attribute, .hljs-meta, .hljs-built_in, .hljs-selector-attr,
.hljs-selector-class, .hljs-selector-id { color: var(--tok-type); }
.hljs-literal, .hljs-number, .hljs-bullet { color: var(--tok-number); }
.hljs-regexp, .hljs-string, .hljs-meta .hljs-string { color: var(--tok-string); }
.hljs-symbol, .hljs-variable, .hljs-name, .hljs-selector-tag, .hljs-selector-pseudo { color: var(--tok-var); }
.hljs-comment, .hljs-code, .hljs-formula, .hljs-quote { color: var(--tok-comment); }
.hljs-section, .hljs-strong { font-weight: bold; }
.hljs-emphasis { font-style: italic; }
.hljs-addition { color: var(--tok-string); background-color: var(--tok-added-bg); }
.hljs-deletion { color: var(--tok-var); background-color: var(--tok-removed-bg); }
`;

export function readChoice(): Choice {
  const stored = localStorage.getItem(STORAGE_KEY);
  return CHOICES.includes(stored as Choice) ? (stored as Choice) : "system";
}

export function saveChoice(choice: Choice): void {
  localStorage.setItem(STORAGE_KEY, choice);
}

/** 저장된 색상 테마 id. 없거나 목록에 없거나 종류가 다르면 기본값이다. */
export function readColorTheme(kind: ThemeKind): string {
  const stored = localStorage.getItem(COLOR_KEY[kind]);
  const found = COLOR_THEMES.find((t) => t.id === stored && t.kind === kind);
  return found ? found.id : DEFAULT_COLOR_THEME[kind];
}

export function saveColorTheme(kind: ThemeKind, id: string): void {
  localStorage.setItem(COLOR_KEY[kind], id);
}

/** 실효 테마에 대응하는 색 묶음. 같은 색상 테마는 한 번만 계산한다. */
export function paletteFor(effective: Effective): Palette {
  const id = readColorTheme(effective);
  let palette = derivedCache.get(id);
  if (!palette) {
    palette = deriveColors(COLOR_THEMES.find((t) => t.id === id)!);
    derivedCache.set(id, palette);
  }
  return palette;
}

function systemQuery(): MediaQueryList {
  return window.matchMedia("(prefers-color-scheme: dark)");
}

export function effectiveOf(choice: Choice): Effective {
  if (choice === "system") return systemQuery().matches ? "dark" : "light";
  return choice;
}

/** OS 외관이 바뀌면 알린다. 선택 테마가 system일 때만 의미가 있다. */
export function onSystemChange(listener: () => void): void {
  systemQuery().addEventListener("change", listener);
}

/**
 * 네이티브 테마(타이틀바 등)를 **선택 테마**에 맞춘다. 실효 테마가 아니라 선택 테마를 받는 것이
 * 핵심이다 — `setTheme`은 창 하나가 아니라 NSApplication 전체의 appearance를 고정하고,
 * 고정된 appearance는 webview로 전파돼 `prefers-color-scheme`까지 오염시킨다. 그러면
 * `effectiveOf("system")`이 우리가 고정한 이전 테마를 되읽어 시스템 모드가 갇힌다.
 * 그래서 system일 때는 null을 넘겨 강제를 푼다 (ADR 260824-224840).
 *
 * 반드시 applyChrome보다 **먼저** await해야 한다. 강제를 풀기 전에 matchMedia를 읽으면
 * 여전히 낡은 값을 읽는다.
 */
export async function applyNativeTheme(choice: Choice): Promise<void> {
  try {
    await getCurrentWindow().setTheme(choice === "system" ? null : choice);
  } catch {
    // 실패해도 본문 테마는 applyChrome이 적용한다.
  }
}

/**
 * 문서 본문·코드 하이라이팅을 팔레트에 맞춘다. 색은 `<html>`의 인라인 변수로 건다 —
 * styles.css의 `[data-theme]` 값은 색상 테마가 없을 때의 바탕이 된다.
 * 네이티브 테마는 applyNativeTheme가, mermaid 재렌더는 호출자가 담당한다.
 */
export function applyChrome(palette: Palette): void {
  const root = document.documentElement;
  root.dataset.theme = palette.kind;
  // 라이트 전용으로 만들지 않는 변수가 이전 테마 값으로 남지 않게 먼저 전부 지운다.
  for (const name of ALL_VAR_NAMES) root.style.removeProperty(name);
  for (const [name, value] of Object.entries(palette.vars)) root.style.setProperty(name, value);

  if (!hljsStyleEl) {
    hljsStyleEl = document.createElement("style");
    hljsStyleEl.id = "hljs-theme";
    document.head.appendChild(hljsStyleEl);
    hljsStyleEl.textContent = HLJS_CSS;
  }
}

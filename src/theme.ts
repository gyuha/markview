import { getCurrentWindow } from "@tauri-apps/api/window";
// highlight.js 테마는 두 벌을 문자열로 받아 <style> 내용만 갈아끼운다.
// 정적 import로 두 벌을 넣으면 둘이 동시에 적용돼 색이 섞인다.
import darkCss from "highlight.js/styles/github-dark.css?inline";
import lightCss from "highlight.js/styles/github.css?inline";

/** 사용자가 고른 값. 저장되는 것은 이것이다. */
export type Choice = "light" | "dark" | "system";
/** 실제로 화면에 적용되는 값. system일 때 OS 상태에서 유도된다. */
export type Effective = "light" | "dark";

const STORAGE_KEY = "markview.theme";
const CHOICES: Choice[] = ["light", "dark", "system"];

let hljsStyleEl: HTMLStyleElement | null = null;

export function readChoice(): Choice {
  const stored = localStorage.getItem(STORAGE_KEY);
  return CHOICES.includes(stored as Choice) ? (stored as Choice) : "system";
}

export function saveChoice(choice: Choice): void {
  localStorage.setItem(STORAGE_KEY, choice);
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
 * 앱 크롬·문서 본문·코드 하이라이팅을 실효 테마에 맞춘다.
 * mermaid 재렌더는 호출자가 담당한다 (탭마다 상태가 다르므로).
 */
export function applyChrome(effective: Effective): void {
  document.documentElement.dataset.theme = effective;

  if (!hljsStyleEl) {
    hljsStyleEl = document.createElement("style");
    hljsStyleEl.id = "hljs-theme";
    document.head.appendChild(hljsStyleEl);
  }
  hljsStyleEl.textContent = effective === "dark" ? darkCss : lightCss;

  // 네이티브 창 크롬(타이틀바)까지 맞춘다. 실패해도 본문 테마는 이미 적용됐으므로 무시한다.
  void getCurrentWindow()
    .setTheme(effective)
    .catch(() => {});
}

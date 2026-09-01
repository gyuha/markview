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
 * 문서 본문·코드 하이라이팅을 실효 테마에 맞춘다.
 * 네이티브 테마는 applyNativeTheme가, mermaid 재렌더는 호출자가 담당한다.
 */
export function applyChrome(effective: Effective): void {
  document.documentElement.dataset.theme = effective;

  if (!hljsStyleEl) {
    hljsStyleEl = document.createElement("style");
    hljsStyleEl.id = "hljs-theme";
    document.head.appendChild(hljsStyleEl);
  }
  hljsStyleEl.textContent = effective === "dark" ? darkCss : lightCss;
}

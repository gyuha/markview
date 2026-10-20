/**
 * 문서 최대 너비 4단계(좁게·보통·넓게·전체) — 고른 값을 localStorage에 두고 `--doc-width` CSS 변수로 건다.
 * '보통'은 변수를 걸지 않아 기존 값(보기·분할 46rem, 편집 전용 800px)이 그대로 남는다.
 */
const KEY = "markview.docWidth";

export type DocWidth = "narrow" | "normal" | "wide" | "full";

export const DOC_WIDTHS: { value: DocWidth; label: string }[] = [
  { value: "narrow", label: "좁게" },
  { value: "normal", label: "보통" },
  { value: "wide", label: "넓게" },
  { value: "full", label: "전체" },
];

const CSS_VALUE: Record<DocWidth, string | null> = {
  narrow: "38rem",
  normal: null,
  wide: "64rem",
  full: "100%",
};

/** 다른 창이 바꾼 저장 키가 문서 너비인지 — storage 이벤트 동기화용. */
export function isDocWidthStorageKey(key: string | null): boolean {
  return key === KEY;
}

/** 저장된 값. 없거나 모르는 값이면 '보통'이다. */
export function readDocWidth(): DocWidth {
  try {
    const stored = localStorage.getItem(KEY);
    return DOC_WIDTHS.some((w) => w.value === stored) ? (stored as DocWidth) : "normal";
  } catch {
    return "normal";
  }
}

export function saveDocWidth(width: DocWidth): void {
  try {
    localStorage.setItem(KEY, width);
  } catch {
    // 저장하지 못해도 이번 실행에는 적용된다.
  }
}

/** 화면에 적용한다. '보통'은 변수를 지워 CSS의 기존 값으로 돌아간다. */
export function applyDocWidth(width: DocWidth): void {
  const value = CSS_VALUE[width];
  if (value) document.documentElement.style.setProperty("--doc-width", value);
  else document.documentElement.style.removeProperty("--doc-width");
}

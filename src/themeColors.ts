// 색상 테마(배경·전경·강조색·터미널 8색) 하나에서 앱이 쓰는 모든 색을 계산한다.
// DOM·Tauri를 건드리지 않는 순수 함수라 Node 테스트(scripts/theme-colors.test.mjs)가 그대로 읽는다.
import type { ColorTheme, ThemeKind } from "./themes.generated";

export interface Derived {
  id: string;
  kind: ThemeKind;
  /** `<html>`에 인라인으로 거는 CSS 변수. 값은 #rrggbb 또는 rgb(r g b / a%). */
  vars: Record<string, string>;
  /** mermaid `theme: "base"`의 themeVariables. 값은 #rrggbb(mermaid가 색을 계산하므로). */
  mermaid: Record<string, string | boolean>;
}

type Rgb = [number, number, number];

function parse(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function hex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
}

/** `weight`은 a의 비중(0~1). */
export function mix(a: string, b: string, weight: number): string {
  const [pa, pb] = [parse(a), parse(b)];
  return hex(pa.map((v, i) => v * weight + pb[i] * (1 - weight)) as Rgb);
}

function luminance(color: string): number {
  const [r, g, b] = parse(color).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** 대비가 모자라면 배경과 가장 대비되는 극단(검정/흰색) 쪽으로 조금씩 당긴다. */
export function ensureContrast(color: string, bg: string, min: number): string {
  if (contrast(color, bg) >= min) return color;
  const extreme = contrast("#000000", bg) >= contrast("#ffffff", bg) ? "#000000" : "#ffffff";
  for (let w = 0.05; w < 1; w += 0.05) {
    const next = mix(extreme, color, w);
    if (contrast(next, bg) >= min) return next;
  }
  return extreme;
}

function alpha(color: string, percent: number): string {
  const [r, g, b] = parse(color);
  return `rgb(${r} ${g} ${b} / ${percent}%)`;
}

/** 다크에서만 만드는 Muya 변수 — 라이트에서는 Muya 기본값을 지우지 않으려고 건드리지 않는다. */
const DARK_ONLY = [
  "--delete-color",
  "--input-bg-color",
  "--button-bg-color",
  "--button-bg-color-hover",
  "--float-hover-color",
  "--float-shadow",
];

/** applyChrome이 테마를 바꿀 때 먼저 지울 변수 전부. */
export const ALL_VAR_NAMES: readonly string[] = [
  "--bg", "--fg", "--fg-muted", "--border", "--code-bg", "--quote-border", "--link",
  "--error-bg", "--error-fg", "--scrollbar-thumb", "--scrollbar-thumb-hover",
  "--editor-color", "--editor-color-80", "--editor-color-50", "--editor-color-30",
  "--editor-color-10", "--editor-color-04", "--editor-bg-color", "--theme-color",
  "--highlight-color", "--selection-color", "--link-color", "--icon-color",
  "--code-block-bg-color", "--table-border-color", "--float-bg-color", "--float-border-color",
  "--button-border", ...DARK_ONLY,
  "--tok-comment", "--tok-keyword", "--tok-string", "--tok-number", "--tok-func",
  "--tok-type", "--tok-var", "--tok-added-bg", "--tok-removed-bg",
];

export function deriveColors(t: ColorTheme): Derived {
  const bg = t.background;
  const fg = ensureContrast(t.foreground, bg, 4.5);
  const n = t.normal;
  const muted = ensureContrast(mix(fg, bg, 0.62), bg, 4.5);
  const border = mix(fg, bg, 0.2);
  const codeBg = mix(fg, bg, 0.06);
  const link = ensureContrast(n.blue, bg, 4.5);
  const errorFg = ensureContrast(n.red, bg, 4.5);
  const tok = (c: string, min = 3.5) => ensureContrast(c, bg, min);
  const dark = t.kind === "dark";

  const vars: Record<string, string> = {
    "--bg": bg,
    "--fg": fg,
    "--fg-muted": muted,
    "--border": border,
    "--code-bg": codeBg,
    "--quote-border": border,
    "--link": link,
    "--error-bg": mix(n.red, bg, 0.12),
    "--error-fg": errorFg,
    "--scrollbar-thumb": alpha(fg, 22),
    "--scrollbar-thumb-hover": alpha(fg, 38),

    // Muya — 앱 팔레트와 같은 색으로 덮는다(ADR 261010-202536).
    "--editor-color": fg,
    "--editor-color-80": fg,
    "--editor-color-50": muted,
    "--editor-color-30": mix(fg, bg, 0.35),
    "--editor-color-10": border,
    "--editor-color-04": codeBg,
    "--editor-bg-color": bg,
    "--theme-color": link,
    "--highlight-color": alpha(n.yellow, 40),
    "--selection-color": alpha(link, 25),
    "--link-color": link,
    "--icon-color": muted,
    "--code-block-bg-color": codeBg,
    "--table-border-color": border,
    "--float-bg-color": dark ? codeBg : bg,
    "--float-border-color": border,
    "--button-border": `1px solid ${border}`,

    // 코드 하이라이트 토큰 — highlight.js·Muya(Prism)·CodeMirror가 같이 쓴다.
    "--tok-comment": tok(mix(fg, bg, 0.5), 3),
    "--tok-keyword": tok(n.magenta),
    "--tok-string": tok(n.green),
    "--tok-number": tok(n.yellow),
    "--tok-func": tok(n.blue),
    "--tok-type": tok(n.cyan),
    "--tok-var": tok(n.red),
    "--tok-added-bg": mix(n.green, bg, 0.2),
    "--tok-removed-bg": mix(n.red, bg, 0.2),
  };

  if (dark) {
    vars["--delete-color"] = errorFg;
    vars["--input-bg-color"] = alpha(fg, 8);
    vars["--button-bg-color"] = mix(fg, bg, 0.08);
    vars["--button-bg-color-hover"] = mix(fg, bg, 0.12);
    vars["--float-hover-color"] = alpha(fg, 6);
    vars["--float-shadow"] = "rgb(0 0 0 / 60%) 0 0 0 1px, rgb(0 0 0 / 50%) 0 8px 24px";
  }

  const mermaid: Derived["mermaid"] = {
    darkMode: dark,
    background: bg,
    primaryColor: mix(n.blue, bg, 0.22),
    primaryTextColor: fg,
    primaryBorderColor: n.blue,
    secondaryColor: mix(n.green, bg, 0.22),
    secondaryTextColor: fg,
    secondaryBorderColor: n.green,
    tertiaryColor: codeBg,
    tertiaryTextColor: fg,
    tertiaryBorderColor: border,
    lineColor: muted,
    textColor: fg,
    mainBkg: mix(n.blue, bg, 0.22),
    nodeBorder: n.blue,
    clusterBkg: codeBg,
    clusterBorder: border,
    titleColor: fg,
    edgeLabelBackground: bg,
    noteBkgColor: mix(n.yellow, bg, 0.22),
    noteTextColor: fg,
    noteBorderColor: n.yellow,
  };

  return { id: t.id, kind: t.kind, vars, mermaid };
}

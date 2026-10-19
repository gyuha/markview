// themes/*.yaml → src/themes.generated.ts. 앱은 실행 중에 YAML을 읽지 않는다(ADR 261019-134956).
//   node scripts/gen-themes.mjs          생성 파일을 다시 쓴다
//   node scripts/gen-themes.mjs --check  생성 파일이 최신인지만 본다 (아니면 종료코드 1)
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const THEMES_DIR = join(root, "themes");
const OUT = join(root, "src/themes.generated.ts");
const NORMAL_KEYS = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];

const unquote = (v) => v.trim().replace(/^"(.*)"$/, "$1");

/** 이 YAML은 `key: value`와 두 단계 중첩뿐이라 파서 의존성 없이 줄 단위로 읽는다. */
export function parseTheme(text, id) {
  const top = {};
  const normal = {};
  let inTerminal = false;
  let inNormal = false;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    const [key, ...rest] = line.trim().split(":");
    const value = rest.join(":");
    if (indent === 0) {
      inTerminal = key === "terminal_colors";
      inNormal = false;
      if (!inTerminal) top[key] = unquote(value);
    } else if (indent === 2 && inTerminal) {
      inNormal = key === "normal";
    } else if (indent === 4 && inNormal) {
      normal[key] = unquote(value);
    }
  }
  const theme = {
    id,
    name: top.name,
    kind: top.details === "lighter" ? "light" : "dark",
    background: top.background,
    foreground: top.foreground,
    accent: top.accent,
    normal: Object.fromEntries(NORMAL_KEYS.map((k) => [k, normal[k]])),
  };
  const missing = [theme.name, theme.background, theme.foreground, theme.accent, ...Object.values(theme.normal)];
  if (missing.some((v) => !v) || !["lighter", "darker"].includes(top.details)) {
    throw new Error(`${id}: 필수 필드가 없거나 details 가 lighter/darker 가 아님`);
  }
  return theme;
}

export function readThemes() {
  return readdirSync(THEMES_DIR)
    .filter((f) => f.endsWith(".yaml"))
    .sort()
    .map((f) => parseTheme(readFileSync(join(THEMES_DIR, f), "utf8"), f.replace(/\.yaml$/, "")));
}

export function renderModule(themes) {
  const rows = themes.map((t) => `  ${JSON.stringify(t)},`).join("\n");
  return `// 이 파일은 scripts/gen-themes.mjs 가 themes/*.yaml 에서 만든다. 직접 고치지 않는다.
export type ThemeKind = "light" | "dark";

export interface ColorTheme {
  id: string;
  name: string;
  /** YAML의 details: lighter → light, darker → dark. */
  kind: ThemeKind;
  background: string;
  foreground: string;
  accent: string;
  normal: Record<"black" | "red" | "green" | "yellow" | "blue" | "magenta" | "cyan" | "white", string>;
}

export const COLOR_THEMES: readonly ColorTheme[] = [
${rows}
];
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const next = renderModule(readThemes());
  if (process.argv.includes("--check")) {
    let current = "";
    try {
      current = readFileSync(OUT, "utf8");
    } catch {}
    if (current !== next) {
      console.error("src/themes.generated.ts 가 최신이 아니다: node scripts/gen-themes.mjs");
      process.exit(1);
    }
  } else {
    writeFileSync(OUT, next);
  }
}

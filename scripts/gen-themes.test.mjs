import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseTheme, readThemes, renderModule } from "./gen-themes.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("YAML 하나를 읽어 이름·종류·색을 뽑는다", () => {
  const theme = parseTheme(
    readFileSync(join(root, "themes/catppuccin-mocha.yaml"), "utf8"),
    "catppuccin-mocha",
  );
  assert.equal(theme.id, "catppuccin-mocha");
  assert.equal(theme.name, "Catppuccin Mocha");
  assert.equal(theme.kind, "dark"); // details: darker
  assert.equal(theme.background, "#1e1e2e");
  assert.equal(theme.foreground, "#cdd6f4");
  assert.equal(theme.accent, "#b4befe");
  assert.equal(theme.normal.blue, "#89b4fa");
  assert.deepEqual(Object.keys(theme.normal).sort(), [
    "black", "blue", "cyan", "green", "magenta", "red", "white", "yellow",
  ]);
});

test("details: lighter 는 light 로 분류한다", () => {
  const theme = parseTheme(
    readFileSync(join(root, "themes/github-light.yaml"), "utf8"),
    "github-light",
  );
  assert.equal(theme.kind, "light");
});

test("themes/ 의 YAML 112개가 전부 들어가고 light 32 / dark 80 이다", () => {
  const yamls = readdirSync(join(root, "themes")).filter((f) => f.endsWith(".yaml"));
  const themes = readThemes();
  assert.equal(yamls.length, 112);
  assert.equal(themes.length, yamls.length);
  assert.equal(themes.filter((t) => t.kind === "light").length, 32);
  assert.equal(themes.filter((t) => t.kind === "dark").length, 80);
});

test("모든 색이 #rrggbb 이다", () => {
  const hex = /^#[0-9a-f]{6}$/i;
  for (const t of readThemes()) {
    for (const c of [t.background, t.foreground, t.accent, ...Object.values(t.normal)]) {
      assert.match(c, hex, `${t.id}: ${c}`);
    }
  }
});

test("src/themes.generated.ts 가 YAML 에서 만든 결과와 같다 (최신이 아니면 gen-themes 를 다시 실행)", () => {
  const onDisk = readFileSync(join(root, "src/themes.generated.ts"), "utf8");
  assert.equal(onDisk, renderModule(readThemes()));
});

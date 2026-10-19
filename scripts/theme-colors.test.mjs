import { test } from "node:test";
import assert from "node:assert/strict";
import { readThemes } from "./gen-themes.mjs";
import { contrast, deriveColors, ensureContrast, mix, ALL_VAR_NAMES } from "../src/themeColors.ts";

const HEX = /^#[0-9a-f]{6}$/i;
const RGB = /^rgb\(\d{1,3} \d{1,3} \d{1,3} \/ \d{1,3}%\)$/;
const themes = readThemes();
const github = themes.find((t) => t.id === "github-light");

test("mix: 가중치 1이면 첫 색, 0이면 둘째 색, 0.5는 중간", () => {
  assert.equal(mix("#000000", "#ffffff", 1), "#000000");
  assert.equal(mix("#000000", "#ffffff", 0), "#ffffff");
  assert.equal(mix("#000000", "#ffffff", 0.5), "#808080");
});

test("contrast: 흑백은 21, 같은 색은 1", () => {
  assert.equal(Math.round(contrast("#000000", "#ffffff")), 21);
  assert.equal(contrast("#777777", "#777777"), 1);
});

test("ensureContrast: 모자라면 읽히는 쪽 극단으로 당기고, 충분하면 그대로 둔다", () => {
  assert.equal(ensureContrast("#222222", "#ffffff", 4.5), "#222222");
  const fixed = ensureContrast("#cccccc", "#ffffff", 4.5);
  assert.ok(contrast(fixed, "#ffffff") >= 4.5);
});

test("파생 색은 CSS 변수 이름이 정해진 집합 안에 있다 (정리 때 빠지지 않게)", () => {
  for (const t of themes) {
    for (const name of Object.keys(deriveColors(t).vars)) {
      assert.ok(ALL_VAR_NAMES.includes(name), `${t.id}: ${name}`);
    }
  }
});

test("112개 전부 본문 대비비 ≥ 4.5 이고 모든 변수 값이 유효한 색이다", () => {
  assert.equal(themes.length, 112);
  for (const t of themes) {
    const d = deriveColors(t);
    assert.ok(contrast(d.vars["--fg"], d.vars["--bg"]) >= 4.5, `${t.id}: 본문 대비`);
    assert.ok(contrast(d.vars["--fg-muted"], d.vars["--bg"]) >= 4.5, `${t.id}: 보조 글자 대비`);
    assert.ok(contrast(d.vars["--link"], d.vars["--bg"]) >= 4.5, `${t.id}: 링크 대비`);
    for (const [name, value] of Object.entries(d.vars)) {
      if (name === "--float-shadow") continue; // 색 둘이 섞인 box-shadow 값
      assert.ok(HEX.test(value) || RGB.test(value) || /^1px solid #[0-9a-f]{6}$/i.test(value), `${t.id}: ${name}=${value}`);
    }
    for (const [name, value] of Object.entries(d.mermaid)) {
      if (typeof value === "string") assert.match(value, HEX, `${t.id}: mermaid ${name}`);
    }
  }
});

test("본문·UI 변수는 배경·전경에서 유도되고 kind를 그대로 싣는다", () => {
  const d = deriveColors(github);
  assert.equal(d.kind, "light");
  assert.equal(d.id, "github-light");
  assert.equal(d.vars["--bg"], github.background);
  assert.equal(d.vars["--editor-bg-color"], github.background);
});

test("다크 전용 Muya 변수는 라이트에서 만들지 않는다 (Muya 기본값을 지우지 않는다)", () => {
  const light = deriveColors(github).vars;
  const dark = deriveColors(themes.find((t) => t.id === "github-dark")).vars;
  assert.equal(light["--button-bg-color"], undefined);
  assert.ok(dark["--button-bg-color"]);
});

test("mermaid 는 base 테마의 themeVariables 로 쓸 수 있고 darkMode 가 kind 를 따른다", () => {
  assert.equal(deriveColors(github).mermaid.darkMode, false);
  assert.equal(deriveColors(themes.find((t) => t.id === "dracula-default")).mermaid.darkMode, true);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./update-homebrew-cask.mjs", import.meta.url));
const run = (...args) => spawnSync("node", [script, ...args], { encoding: "utf8" });

function fixture(version = "1.2.3") {
  const dir = mkdtempSync(join(tmpdir(), "cask-test-"));
  const dmg = join(dir, `markview_${version}_aarch64.dmg`);
  writeFileSync(dmg, "fake dmg bytes");
  return { dir, dmg, out: join(dir, "Casks", "markview.rb") };
}

test("버전·sha256·url·app 이름이 Cask에 들어간다", () => {
  const { dmg, out } = fixture();
  const r = run("--version", "1.2.3", "--dmg", dmg, "--out", out);
  assert.equal(r.status, 0, r.stderr);
  const cask = readFileSync(out, "utf8");
  const sha = createHash("sha256").update("fake dmg bytes").digest("hex");
  assert.match(cask, /^cask "markview" do\n  version "1\.2\.3"\n  sha256 "/);
  assert.ok(cask.includes(`sha256 "${sha}"`));
  assert.ok(cask.includes('url "https://github.com/gyuha/markview/releases/download/v#{version}/markview_#{version}_aarch64.dmg"'));
  assert.ok(cask.includes('app "markview.app"'));
  assert.ok(cask.includes("depends_on arch: :arm64"));
});

test("잘못된 버전은 거부하고 파일을 쓰지 않는다", () => {
  const { dmg, out } = fixture();
  const r = run("--version", "v1.2", "--dmg", dmg, "--out", out);
  assert.notEqual(r.status, 0);
  assert.throws(() => readFileSync(out));
});

test("DMG 파일 이름이 버전과 다르면 거부한다", () => {
  const { dmg, out } = fixture("1.2.3");
  const r = run("--version", "1.2.4", "--dmg", dmg, "--out", out);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /일치하지 않습니다/);
});

test("출력 파일 이름이 markview.rb가 아니면 거부한다", () => {
  const { dmg, dir } = fixture();
  const r = run("--version", "1.2.3", "--dmg", dmg, "--out", join(dir, "other.rb"));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /markview\.rb/);
});

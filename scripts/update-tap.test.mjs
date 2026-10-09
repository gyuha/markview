import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findDmgAsset, sha256Of, updateTap } from "./update-tap.mjs";

const digest = "sha256:" + "a".repeat(64);
const asset = { name: "markview_1.2.3_aarch64.dmg", browser_download_url: "https://example/x.dmg", digest };

test("findDmgAsset: 공개 릴리스에서 DMG와 sha256을 고른다", () => {
  const got = findDmgAsset({ draft: false, assets: [asset] }, "1.2.3");
  assert.deepEqual(got, { name: asset.name, url: asset.browser_download_url, sha256: "a".repeat(64) });
});

test("findDmgAsset: 초안 릴리스는 던진다", () => {
  assert.throws(() => findDmgAsset({ draft: true, assets: [asset] }, "1.2.3"), /초안/);
});

test("findDmgAsset: digest가 없으면 던진다", () => {
  assert.throws(() => findDmgAsset({ draft: false, assets: [{ ...asset, digest: null }] }, "1.2.3"), /digest/);
});

test("findDmgAsset: 해당 버전 DMG가 없으면 null", () => {
  assert.equal(findDmgAsset({ draft: false, assets: [asset] }, "9.9.9"), null);
});

test("sha256Of: 파일 내용의 sha256", () => {
  const f = join(mkdtempSync(join(tmpdir(), "sha-")), "f");
  writeFileSync(f, "abc");
  assert.equal(sha256Of(f), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

/** 로컬 bare 저장소를 tap 대신 쓴다. 네트워크·실제 tap을 건드리지 않는다. */
function localTap() {
  const root = mkdtempSync(join(tmpdir(), "tap-test-"));
  const bare = join(root, "tap.git");
  const seed = join(root, "seed");
  const git = (cwd, ...a) => execFileSync("git", a, { cwd, stdio: "pipe" });
  mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main");
  mkdirSync(join(seed, "Casks"));
  writeFileSync(join(seed, "Casks", "markview.rb"), "old\n");
  git(seed, "add", ".");
  git(seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
  git(root, "clone", "-q", "--bare", seed, bare);
  const dmg = join(root, "markview_1.2.3_aarch64.dmg");
  writeFileSync(dmg, "fake dmg");
  return { root, bare, dmg, show: () => execFileSync("git", ["show", "main:Casks/markview.rb"], { cwd: bare, encoding: "utf8" }) };
}
const env = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

test("updateTap dry: 커밋은 만들되 push하지 않는다", () => {
  Object.assign(process.env, env);
  const t = localTap();
  const r = updateTap({ tapUrl: t.bare, dmgPath: t.dmg, version: "1.2.3", dry: true, workDir: t.root });
  assert.equal(r, "dry");
  assert.equal(t.show(), "old\n");
});

test("updateTap: push하면 tap의 Cask가 새 버전이 되고, 다시 하면 unchanged", () => {
  Object.assign(process.env, env);
  const t = localTap();
  assert.equal(updateTap({ tapUrl: t.bare, dmgPath: t.dmg, version: "1.2.3", dry: false, workDir: t.root }), "pushed");
  assert.match(t.show(), /version "1\.2\.3"/);
  rmSyncTap(t.root);
  assert.equal(updateTap({ tapUrl: t.bare, dmgPath: t.dmg, version: "1.2.3", dry: false, workDir: t.root }), "unchanged");
});

const rmSyncTap = (root) => rmSync(join(root, "tap"), { recursive: true, force: true });

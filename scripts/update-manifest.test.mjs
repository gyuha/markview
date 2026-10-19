import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeManifest } from "./update-manifest.mjs";

const mac = { version: "0.4.0", platform: "darwin-aarch64", url: "https://x/mac.app.tar.gz", signature: " SIGMAC \n", notes: "노트", pubDate: "2026-10-20T00:00:00Z" };

test("서명의 앞뒤 공백을 다듬고 이 플랫폼 항목만 만든다", () => {
  const m = mergeManifest(null, mac);
  assert.deepEqual(m, {
    version: "0.4.0",
    notes: "노트",
    pub_date: "2026-10-20T00:00:00Z",
    platforms: { "darwin-aarch64": { url: "https://x/mac.app.tar.gz", signature: "SIGMAC" } },
  });
});

test("다른 플랫폼을 병합해도 앞의 항목과 노트·날짜는 그대로다", () => {
  const first = mergeManifest(null, mac);
  const both = mergeManifest(first, { ...mac, platform: "darwin-x86_64", url: "https://x/intel.tar.gz", signature: "SIGI", notes: undefined, pubDate: undefined });
  assert.deepEqual(Object.keys(both.platforms).sort(), ["darwin-aarch64", "darwin-x86_64"]);
  assert.deepEqual(both.platforms["darwin-aarch64"], first.platforms["darwin-aarch64"]);
  assert.equal(both.notes, "노트");
  assert.equal(both.pub_date, "2026-10-20T00:00:00Z");
});

test("같은 플랫폼을 다시 병합하면 교체한다", () => {
  const again = mergeManifest(mergeManifest(null, mac), { ...mac, url: "https://x/new.tar.gz", signature: "NEW" });
  assert.deepEqual(again.platforms, { "darwin-aarch64": { url: "https://x/new.tar.gz", signature: "NEW" } });
});

test("버전이 다른 기존 latest.json에는 병합하지 않는다", () => {
  const old = mergeManifest(null, { ...mac, version: "0.3.9" });
  assert.throws(() => mergeManifest(old, mac), /버전/);
});

test("서명·URL·버전·플랫폼이 비어 있으면 거부한다", () => {
  assert.throws(() => mergeManifest(null, { ...mac, signature: "  \n" }), /서명/);
  assert.throws(() => mergeManifest(null, { ...mac, url: "" }), /url/);
  assert.throws(() => mergeManifest(null, { ...mac, version: "" }), /version/);
  assert.throws(() => mergeManifest(null, { ...mac, platform: "" }), /platform/);
});

test("CLI: 기존 파일에 병합해 쓰고, 노트 파일을 읽고, 오류는 종료 코드 1이다", () => {
  const dir = mkdtempSync(join(tmpdir(), "markview-manifest-test-"));
  try {
    writeFileSync(join(dir, "a.sig"), "CLISIG\n");
    writeFileSync(join(dir, "notes.txt"), "첫째 줄\n둘째 줄\n");
    const base = ["scripts/update-manifest.mjs", "--version", "1.0.0", "--platform", "darwin-aarch64", "--url", "https://x/a", "--sig-file", join(dir, "a.sig"), "--out", join(dir, "latest.json")];
    execFileSync("node", [...base, "--notes-file", join(dir, "notes.txt"), "--pub-date", "2026-01-01T00:00:00Z"]);
    const out = JSON.parse(readFileSync(join(dir, "latest.json"), "utf8"));
    assert.equal(out.notes, "첫째 줄\n둘째 줄");
    assert.equal(out.platforms["darwin-aarch64"].signature, "CLISIG");
    // 기존 파일(--existing)에 다른 플랫폼을 병합한다.
    execFileSync("node", ["scripts/update-manifest.mjs", "--version", "1.0.0", "--platform", "darwin-x86_64", "--url", "https://x/b", "--sig-file", join(dir, "a.sig"), "--existing", join(dir, "latest.json"), "--out", join(dir, "latest.json")]);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(dir, "latest.json"), "utf8")).platforms).sort(), ["darwin-aarch64", "darwin-x86_64"]);
    const bad = spawnSync("node", ["scripts/update-manifest.mjs", "--version", "1.0.0"], { encoding: "utf8" });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /update-manifest/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

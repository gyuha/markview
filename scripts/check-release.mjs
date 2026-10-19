// 앱 안 업데이트의 배포 쪽 계약을 판정한다(fg-loop 계약의 C5). 실제 빌드·릴리스·push는 하지 않는다.
//   R01 tauri.conf.json의 updater 공개 키와 엔드포인트
//   R02 공개 키가 로컬 서명 키(~/.tauri/markview.key.pub)와 짝이고 twin-deck 키를 재사용하지 않았다
//   R03 개인 키(서명 키)가 저장소에 들어가지 않았다
//   R04 웹뷰 capability에 updater·process·dialog·shell 권한이 없다(업데이트는 Rust 커맨드가 한다 — ADR 261010-234732)
//   R05 Rust가 updater 플러그인을 등록하고 check_update·install_update 커맨드를 노출한다
//   R06 scripts/update-manifest.mjs의 latest.json 병합 동작
//   R07 DRY_RUN 배포: 올리는 순서와 latest.json 내용(gh를 부르면 실패하는 가짜 gh로 돌린다)
//   R08 release.sh가 서명 키로 업데이트 산출물을 만든다
// 이 파일은 fg-loop 계약(.forge/loop.md)에 해시로 고정된 판정 기준이다. 통과시키려고 고치지 않는다.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ENDPOINT = "https://github.com/gyuha/markview/releases/latest/download/latest.json";
// twin-deck의 공개 키 ID. 다른 앱의 키를 재사용하면 한쪽 키 유출이 두 앱의 업데이트 채널을 함께 무너뜨린다.
const TWIN_DECK_KEY_ID = "C3ACCDBBEC893632";

let fail = 0;
function check(id, label, ok, detail = "") {
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  [${id}] ${label}${!ok && detail ? `  ${detail}` : ""}`);
}
const read = (p) => readFileSync(p, "utf8");
const exists = (p) => existsSync(p);

// ── R01 ───────────────────────────────────────────────────────────────
const conf = JSON.parse(read("src-tauri/tauri.conf.json"));
const updater = conf.plugins?.updater;
let pubText = "";
try {
  pubText = Buffer.from(updater?.pubkey ?? "", "base64").toString("utf8");
} catch {}
check(
  "R01",
  "tauri.conf.json: updater 공개 키(minisign)와 엔드포인트가 맞다",
  /^untrusted comment: minisign public key: [0-9A-F]{16}\n/.test(pubText) &&
    JSON.stringify(updater?.endpoints) === JSON.stringify([ENDPOINT]),
  JSON.stringify({ pubkeyHead: pubText.slice(0, 60), endpoints: updater?.endpoints }),
);

// ── R02 ───────────────────────────────────────────────────────────────
const pubFile = join(homedir(), ".tauri", "markview.key.pub");
const keyId = /minisign public key: ([0-9A-F]{16})/.exec(pubText)?.[1];
const localPub = exists(pubFile) ? read(pubFile).trim() : null;
check(
  "R02",
  "공개 키 = ~/.tauri/markview.key.pub(로컬 서명 키의 짝)이고 twin-deck 키가 아니다",
  localPub !== null && localPub === (updater?.pubkey ?? "").trim() && !!keyId && keyId !== TWIN_DECK_KEY_ID,
  JSON.stringify({ pubFileExists: localPub !== null, equalsLocal: localPub === (updater?.pubkey ?? "").trim(), keyId }),
);

// ── R03 ───────────────────────────────────────────────────────────────
// 커밋될 수 있는 모든 파일(추적 + 무시되지 않는 새 파일)을 본다. 마커는 이 파일 자신이 걸리지 않게 쪼개 쓴다.
const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { encoding: "utf8", maxBuffer: 1 << 26 })
  .split("\0")
  .filter(Boolean);
const SECRET_PLAIN = "rsign enc" + "rypted secret key";
const SECRET_B64 = Buffer.from("untrusted comment: " + SECRET_PLAIN).toString("base64").slice(0, 40);
const leaked = [];
for (const f of files) {
  if (/\.key$/.test(f)) {
    leaked.push(`${f} (이름)`);
    continue;
  }
  let st;
  try {
    st = statSync(f);
  } catch {
    continue;
  }
  if (!st.isFile() || st.size > 2_000_000) continue;
  const buf = readFileSync(f);
  if (buf.includes(0)) continue; // 바이너리는 건너뛴다
  const text = buf.toString("utf8");
  if (text.includes(SECRET_PLAIN) || text.includes(SECRET_B64)) leaked.push(f);
}
check("R03", "개인 서명 키가 저장소에 없다(커밋될 파일 어디에도 비밀 키 표식이 없다)", leaked.length === 0, `발견: ${leaked.join(", ")}`);

// ── R04 ───────────────────────────────────────────────────────────────
const caps = JSON.parse(read("src-tauri/capabilities/default.json")).permissions ?? [];
const banned = caps.filter((p) => /^(updater|process|dialog|shell|fs|http):/.test(typeof p === "string" ? p : p.identifier ?? ""));
check("R04", "웹뷰 capability에 updater·process·dialog·shell·fs·http 권한이 없다", banned.length === 0, JSON.stringify(banned));

// ── R05 ───────────────────────────────────────────────────────────────
const cargo = read("src-tauri/Cargo.toml");
const lib = read("src-tauri/src/lib.rs");
const handler = /generate_handler!\s*\[([\s\S]*?)\]/.exec(lib)?.[1] ?? "";
check(
  "R05",
  "Rust: tauri-plugin-updater 의존성과 등록, check_update·install_update 커맨드 노출",
  /^tauri-plugin-updater\s*=/m.test(cargo) &&
    /tauri_plugin_updater::Builder::new\(\)/.test(lib) &&
    /\bcheck_update\b/.test(handler) &&
    /\binstall_update\b/.test(handler),
  JSON.stringify({ dep: /^tauri-plugin-updater\s*=/m.test(cargo), registered: /tauri_plugin_updater::Builder::new\(\)/.test(lib), handler: handler.replace(/\s+/g, " ").trim() }),
);

// ── R06 ───────────────────────────────────────────────────────────────
{
  let ok = false;
  let detail = "";
  try {
    const mod = await import(pathToFileURL(join(process.cwd(), "scripts/update-manifest.mjs")).href);
    const base = { version: "1.0.0", platform: "darwin-aarch64", url: "https://x/a.app.tar.gz", signature: " SIG \n", notes: "n", pubDate: "2026-01-01T00:00:00Z" };
    const one = mod.mergeManifest(null, base);
    const two = mod.mergeManifest(one, { ...base, platform: "darwin-x86_64", url: "https://x/b.app.tar.gz", signature: "SIG2" });
    const throws = (fn) => {
      try {
        fn();
        return false;
      } catch {
        return true;
      }
    };
    const dir = mkdtempSync(join(tmpdir(), "markview-manifest-"));
    writeFileSync(join(dir, "a.sig"), "CLISIG\n");
    const cli = spawnSync(
      "node",
      ["scripts/update-manifest.mjs", "--version", "1.0.0", "--platform", "darwin-aarch64", "--url", "https://x/a", "--sig-file", join(dir, "a.sig"), "--notes", "hi", "--out", join(dir, "latest.json")],
      { encoding: "utf8" },
    );
    const cliOut = existsSync(join(dir, "latest.json")) ? JSON.parse(read(join(dir, "latest.json"))) : null;
    rmSync(dir, { recursive: true, force: true });
    ok =
      JSON.stringify(one) === JSON.stringify({ version: "1.0.0", notes: "n", pub_date: "2026-01-01T00:00:00Z", platforms: { "darwin-aarch64": { url: "https://x/a.app.tar.gz", signature: "SIG" } } }) &&
      Object.keys(two.platforms).sort().join() === "darwin-aarch64,darwin-x86_64" &&
      two.platforms["darwin-aarch64"].signature === "SIG" &&
      throws(() => mod.mergeManifest(one, { ...base, version: "2.0.0" })) &&
      throws(() => mod.mergeManifest(null, { ...base, signature: "  " })) &&
      throws(() => mod.mergeManifest(null, { ...base, url: "" })) &&
      cli.status === 0 &&
      cliOut?.version === "1.0.0" &&
      cliOut?.notes === "hi" &&
      cliOut?.platforms?.["darwin-aarch64"]?.signature === "CLISIG";
    detail = JSON.stringify({ cliStatus: cli.status, cliErr: cli.stderr.slice(0, 120) });
  } catch (e) {
    detail = String(e).slice(0, 200);
  }
  check("R06", "update-manifest: 플랫폼 병합·서명 공백 정리·버전 불일치/빈 서명/빈 URL 거부·CLI 출력", ok, detail);
}

// ── R07 ───────────────────────────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), "markview-release-"));
  const bin = join(dir, "bin");
  const work = join(dir, "work");
  mkdirSync(bin);
  mkdirSync(work);
  const ghLog = join(dir, "gh.log");
  // DRY_RUN은 GitHub를 읽지도 바꾸지도 않아야 한다 — gh를 부르면 기록하고 실패한다.
  writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "$@" >> "${ghLog}"\nexit 97\n`);
  chmodSync(join(bin, "gh"), 0o755);
  const run = spawnSync("bash", ["scripts/release.sh", "publish"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DRY_RUN: "1", VERSION_OVERRIDE: "9.9.9", RELEASE_WORK_DIR: work },
    timeout: 120000,
  });
  const out = run.stdout ?? "";
  const lines = out.split("\n");
  const at = (re) => lines.findIndex((l) => re.test(l));
  const iCreate = at(/\[DRY_RUN\] gh release create v9\.9\.9\b.*--draft/);
  const iUpload = at(/\[DRY_RUN\] gh release upload v9\.9\.9\b(?=.*\.app\.tar\.gz)(?=.*\.app\.tar\.gz\.sig)(?=.*latest\.json)/);
  const iPublish = at(/\[DRY_RUN\] gh api .*draft=false/);
  const iTap = at(/\[DRY_RUN\].*update-tap\.mjs 9\.9\.9/);
  const createLine = lines[iCreate] ?? "";
  let manifest = null;
  try {
    manifest = JSON.parse(read(join(work, "latest.json")));
  } catch {}
  const plat = manifest?.platforms?.["darwin-aarch64"];
  const ghCalls = existsSync(ghLog) ? read(ghLog).trim() : "";
  const ok =
    run.status === 0 &&
    ghCalls === "" &&
    iCreate >= 0 &&
    /markview_9\.9\.9_aarch64\.dmg/.test(createLine) &&
    iUpload > iCreate &&
    iPublish > iUpload && // 공개 전에 latest.json이 이미 올라가 있어야 한다
    iTap > iPublish &&
    manifest?.version === "9.9.9" &&
    typeof manifest?.notes === "string" &&
    manifest.notes.trim().length > 0 &&
    Object.keys(manifest?.platforms ?? {}).join() === "darwin-aarch64" &&
    /^https:\/\/github\.com\/[^/]+\/markview\/releases\/download\/v9\.9\.9\/[^/\s]+\.app\.tar\.gz$/.test(plat?.url ?? "") &&
    typeof plat?.signature === "string" &&
    plat.signature.trim().length > 0;
  check(
    "R07",
    "DRY_RUN 배포: gh를 건드리지 않고, 초안 생성 → 업데이트 파일+latest.json 업로드 → 공개 → tap 순서이며 latest.json이 darwin-aarch64 항목을 가진다",
    ok,
    JSON.stringify({ status: run.status, ghCalls, iCreate, iUpload, iPublish, iTap, manifest, stderr: (run.stderr ?? "").slice(-200) }),
  );
  rmSync(dir, { recursive: true, force: true });
}

// ── R08 ───────────────────────────────────────────────────────────────
{
  const sh = read("scripts/release.sh");
  const iKey = sh.indexOf("TAURI_SIGNING_PRIVATE_KEY");
  const iBuild = sh.search(/tauri build/);
  const bundles = /--bundles[ =]+["']?([a-z,]+)/.exec(sh)?.[1] ?? "";
  check(
    "R08",
    "release.sh: 서명 키로 업데이트 산출물을 만들고(app+dmg 번들) 키가 없으면 빌드 전에 멈춘다",
    iKey >= 0 &&
      iBuild > iKey &&
      /createUpdaterArtifacts/.test(sh) &&
      /latest\.json/.test(sh) &&
      /\.app\.tar\.gz/.test(sh) &&
      bundles.split(",").includes("app") &&
      bundles.split(",").includes("dmg"),
    JSON.stringify({ iKey, iBuild, bundles }),
  );
}

console.log(fail === 0 ? "전부 통과" : `실패 ${fail}건`);
process.exit(fail === 0 ? 0 : 1);

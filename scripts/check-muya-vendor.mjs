// vendor/muya/src가 MarkText 고정 커밋의 packages/muya/src와 "그대로"인지 판정한다.
//   - 업스트림의 모든 비테스트 파일(__tests__ 제외)이 vendor에 있고 바이트 단위로 같다.
//   - 다른 파일과 vendor에만 있는 파일은 vendor/muya/PATCHES.md에 경로가 적혀 있어야 하고,
//     변경 줄 합계(추가+삭제, 새 파일은 전체 줄 수)가 300 이하다.
//   - LICENSE가 업스트림 루트 LICENSE와 같고, UPSTREAM이 고정 커밋을 가리킨다.
//   - 앱이 실제로 vendor를 쓴다(src/에서 import하고, npm @muyajs/core로 바꿔치기하지 않는다).
// 이 파일은 fg-loop 계약(.forge/loop.md)에 해시로 고정된 판정 기준이다.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SHA = "34ea9931a34ded1f3d462f0821a12e6eb64cd180";
const REPO = "https://github.com/marktext/marktext.git";
const PATCH_LINE_BUDGET = 300;
const upstreamDir = process.env.MUYA_UPSTREAM_DIR ?? `/tmp/markview-muya-upstream-${SHA.slice(0, 12)}`;

let fail = 0;
function check(ok, label, detail = "") {
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
}

function ensureUpstream() {
  if (existsSync(join(upstreamDir, "packages/muya/src/index.ts"))) return;
  execFileSync("git", ["init", "-q", upstreamDir]);
  execFileSync("git", ["-C", upstreamDir, "fetch", "-q", "--depth", "1", REPO, SHA]);
  execFileSync("git", ["-C", upstreamDir, "checkout", "-q", "FETCH_HEAD"]);
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const isTest = (rel) => rel.split("/").includes("__tests__");

function changedLines(a, b) {
  // git diff --no-index는 차이가 있으면 종료 코드 1을 낸다 — 출력만 쓴다.
  let out = "";
  try {
    out = execFileSync("git", ["diff", "--no-index", "--numstat", a, b], { encoding: "utf8" });
  } catch (e) {
    out = e.stdout ?? "";
  }
  return out
    .trim()
    .split("\n")
    .filter(Boolean)
    .reduce((sum, line) => {
      const [add, del] = line.split("\t");
      return sum + (Number(add) || 0) + (Number(del) || 0);
    }, 0);
}

ensureUpstream();
const upSrc = join(upstreamDir, "packages/muya/src");
const vendorSrc = "vendor/muya/src";

check(existsSync(vendorSrc), "vendor/muya/src 존재");
if (!existsSync(vendorSrc)) process.exit(1);

const upstream = existsSync("vendor/muya/UPSTREAM") ? readFileSync("vendor/muya/UPSTREAM", "utf8") : "";
check(upstream.includes(`marktext/marktext@${SHA}`), "UPSTREAM이 고정 커밋을 가리킨다", `marktext/marktext@${SHA}`);

const license = join(upstreamDir, "LICENSE");
check(
  existsSync("vendor/muya/LICENSE") &&
    readFileSync("vendor/muya/LICENSE").equals(readFileSync(license)),
  "LICENSE가 업스트림 루트 LICENSE(MIT)와 같다",
);

const patches = existsSync("vendor/muya/PATCHES.md") ? readFileSync("vendor/muya/PATCHES.md", "utf8") : "";
const listed = (rel) => patches.includes(`src/${rel}`);

const upFiles = walk(upSrc).map((p) => relative(upSrc, p)).filter((r) => !isTest(r)).sort();
const venFiles = new Set(walk(vendorSrc).map((p) => relative(vendorSrc, p)));

let missing = [];
let unlisted = [];
let budget = 0;
let patched = 0;
for (const rel of upFiles) {
  const v = join(vendorSrc, rel);
  if (!venFiles.has(rel)) {
    missing.push(rel);
    continue;
  }
  venFiles.delete(rel);
  if (readFileSync(v).equals(readFileSync(join(upSrc, rel)))) continue;
  patched++;
  if (!listed(rel)) unlisted.push(rel);
  budget += changedLines(join(upSrc, rel), v);
}
// 업스트림의 테스트 파일을 그대로 가져온 것은 허용한다(판정 대상에서만 뺀다).
const extra = [...venFiles].filter((r) => !isTest(r));
for (const rel of extra) {
  if (!listed(rel)) unlisted.push(rel);
  budget += readFileSync(join(vendorSrc, rel), "utf8").split("\n").length;
}

check(missing.length === 0, `업스트림 비테스트 파일 ${upFiles.length}개가 전부 vendor에 있다`, missing.length ? `없음 ${missing.length}개: ${missing.slice(0, 10).join(", ")}` : "");
check(unlisted.length === 0, `변경·추가 파일(${patched + extra.length}개)이 전부 PATCHES.md에 사유와 함께 적혀 있다`, unlisted.length ? `미기재: ${unlisted.join(", ")}` : "");
check(budget <= PATCH_LINE_BUDGET, `패치 변경 줄 합계 ≤ ${PATCH_LINE_BUDGET}`, `현재 ${budget}줄`);

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const deps = { ...pkg.dependencies, ...pkg.devDependencies };
check(!("@muyajs/core" in deps), "npm @muyajs/core로 바꿔치기하지 않았다");

let imports = "";
try {
  imports = execFileSync("grep", ["-rl", "vendor/muya/src", "src"], { encoding: "utf8" });
} catch {}
check(imports.trim().length > 0, "앱 코드(src/)가 vendor/muya/src를 import한다", imports.trim().replace(/\n/g, ", "));

console.log(fail === 0 ? "전부 통과" : `실패 ${fail}건`);
process.exit(fail === 0 ? 0 : 1);

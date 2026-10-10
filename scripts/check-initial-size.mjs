// 뷰어로 열 때 내려받는 JS가 커지지 않았는지 판정한다. 임시 폴더에 새로 빌드한 뒤
// index.html이 직접 부르는 JS(<script src> + <link rel="modulepreload">) 크기 합을 잰다.
// 기준 1,681,632바이트(Muya 이식 전)의 +5%. Muya는 편집 모드 첫 진입 때 동적으로 불러와야 한다.
// 이 파일은 fg-loop 계약(.forge/loop.md)에 해시로 고정된 판정 기준이다.
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const LIMIT = 1765714;
const outDir = "/tmp/markview-initial-size-check";

execFileSync("pnpm", ["exec", "vite", "build", "--outDir", outDir, "--emptyOutDir", "--logLevel", "error"], {
  stdio: "inherit",
});
const html = readFileSync(join(outDir, "index.html"), "utf8");
const refs = [
  ...html.matchAll(/<script[^>]*\ssrc="([^"]+\.js)"/g),
  ...html.matchAll(/<link[^>]*rel="modulepreload"[^>]*href="([^"]+\.js)"/g),
].map((m) => m[1]);
const total = refs.reduce((sum, ref) => sum + statSync(join(outDir, ref)).size, 0);
for (const ref of refs) console.log(`  ${ref}  ${statSync(join(outDir, ref)).size}`);
const ok = refs.length > 0 && total <= LIMIT;
console.log(`${ok ? "PASS" : "FAIL"}  초기 로드 JS ${total}바이트 (한도 ${LIMIT})`);
process.exit(ok ? 0 : 1);

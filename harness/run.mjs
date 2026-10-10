// 하네스를 사람 눈 없이 판정한다. Vite 개발 서버를 빈 포트로 띄우고, 실제 index.html로 만든
// 하네스 페이지를 Chromium과 WebKit(Tauri가 macOS에서 쓰는 WKWebView와 같은 엔진 계열)에서 연다.
//
//   node harness/run.mjs regression   기존 하네스 출력이 harness/golden/regression.txt와 바이트 단위로 같은가
//   node harness/run.mjs muya         harness/muya-*.ts 전부에서 harness/required-muya.txt의 ID가
//                                     두 엔진 모두 PASS이고 FAIL이 0개인가
//
// 이 파일과 golden/required 목록은 fg-loop 계약(.forge/loop.md)에 해시로 고정된 판정 기준이다.
// 통과시키려고 고치지 않는다 — 기준이 틀렸다면 사람에게 넘긴다.
import { readFileSync, readdirSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { execFileSync } from "node:child_process";
import { createServer } from "vite";
import { chromium, webkit } from "playwright";

const ENGINES = [chromium, webkit];
// 골든을 만들 때와 같은 순서·같은 이름. 헤더 문자열까지 골든에 들어 있다.
const REGRESSION_SPECS = [
  "toolbar.html",
  "tabs.html?files=2",
  "scroll.html",
  "theme.html",
  "popover.html",
  "copy.html",
  "/harness/keymap.html",
];

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.once("error", reject);
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function generate(names) {
  execFileSync("node", ["harness/build-mocked.mjs", ...names], { stdio: "ignore" });
}

/** #out이 비어 있지 않고 1초(4회) 동안 바뀌지 않거나, until이 참이 될 때까지 기다린다. */
async function readOut(page, { until, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  let prev = "";
  let stable = 0;
  let txt = "";
  while (Date.now() < deadline) {
    await page.waitForTimeout(250);
    txt = await page.evaluate(() => document.querySelector("#out")?.textContent ?? "");
    if (until) {
      if (until(txt)) return { txt, timedOut: false };
      continue;
    }
    stable = txt && txt === prev ? stable + 1 : 0;
    prev = txt;
    if (stable >= 4) return { txt, timedOut: false };
  }
  return { txt, timedOut: true };
}

async function runSpecs(base, specs, opts) {
  const results = [];
  for (const engine of ENGINES) {
    const browser = await engine.launch();
    for (const spec of specs) {
      const page = await browser.newPage();
      const url = spec.startsWith("/") ? `${base}${spec}` : `${base}/harness/.generated/${spec}`;
      await page.goto(url);
      const { txt, timedOut } = await readOut(page, opts);
      results.push({ engine: engine.name(), spec, txt, timedOut });
      await page.close();
    }
    await browser.close();
  }
  return results;
}

async function withServer(fn) {
  const port = await freePort();
  const server = await createServer({
    logLevel: "silent",
    clearScreen: false,
    server: { port, strictPort: true, hmr: false },
  });
  await server.listen();
  try {
    return await fn(`http://localhost:${port}`);
  } finally {
    await server.close();
  }
}

async function regression() {
  generate(["toolbar", "tabs", "scroll", "theme", "popover", "copy"]);
  const results = await withServer((base) => runSpecs(base, REGRESSION_SPECS, { timeoutMs: 15000 }));
  const got = results.map((r) => `=== ${r.engine} ${r.spec}\n${r.txt}\n`).join("");
  const want = readFileSync("harness/golden/regression.txt", "utf8");
  if (got === want) {
    console.log(`PASS  회귀 골든 일치 (${results.length}개 페이지)`);
    return 0;
  }
  const g = got.split("\n");
  const w = want.split("\n");
  console.log("FAIL  회귀 골든 불일치 — 다른 줄:");
  for (let i = 0; i < Math.max(g.length, w.length); i++) {
    if (g[i] !== w[i]) console.log(`  ${i + 1}행\n    want ${JSON.stringify(w[i])}\n    got  ${JSON.stringify(g[i])}`);
  }
  return 1;
}

async function muya() {
  const names = readdirSync("harness")
    .filter((f) => /^muya-.*\.ts$/.test(f))
    .map((f) => f.replace(/\.ts$/, ""))
    .sort();
  const required = readFileSync("harness/required-muya.txt", "utf8")
    .split("\n")
    .map((l) => l.match(/^([A-Z]\d{2})\s/)?.[1])
    .filter(Boolean);
  if (names.length === 0) {
    console.log("FAIL  harness/muya-*.ts 하네스가 하나도 없다");
    return 1;
  }
  generate(names);
  // 하네스는 끝나면 마지막 줄에 DONE을 쓴다. DONE 없이 끝난 페이지는 시간 초과로 본다.
  const results = await withServer((base) =>
    runSpecs(
      base,
      names.map((n) => `${n}.html`),
      { until: (t) => /(^|\n)DONE\s*$/.test(t), timeoutMs: 120000 },
    ),
  );
  let bad = 0;
  for (const r of results) {
    console.log(`=== ${r.engine} ${r.spec}${r.timedOut ? "  (시간 초과 — DONE 없음)" : ""}\n${r.txt}`);
    if (r.timedOut) bad++;
  }
  for (const engine of ENGINES.map((e) => e.name())) {
    const lines = results
      .filter((r) => r.engine === engine)
      .flatMap((r) => r.txt.split("\n"));
    const fails = lines.filter((l) => /^FAIL\b/.test(l));
    const passed = new Set(
      lines.map((l) => l.match(/^PASS\s+\[([A-Z]\d{2})\]/)?.[1]).filter(Boolean),
    );
    const missing = required.filter((id) => !passed.has(id));
    console.log(
      `${engine}: 필수 ${required.length}개 중 PASS ${required.length - missing.length}개 · FAIL 줄 ${fails.length}개`,
    );
    if (missing.length) console.log(`  PASS 없음: ${missing.join(" ")}`);
    bad += fails.length + missing.length;
  }
  console.log(bad === 0 ? "PASS  Muya 하네스 전부 통과" : `FAIL  Muya 하네스 문제 ${bad}건`);
  return bad === 0 ? 0 : 1;
}

const mode = process.argv[2];
const modes = { regression, muya };
if (!modes[mode]) {
  console.error("사용법: node harness/run.mjs <regression|muya>");
  process.exit(64);
}
process.exit(await modes[mode]());

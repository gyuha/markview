// 하네스를 사람 눈 없이 판정한다. Vite 개발 서버를 빈 포트로 띄우고, 실제 index.html로 만든
// 하네스 페이지를 Chromium과 WebKit(Tauri가 macOS에서 쓰는 WKWebView와 같은 엔진 계열)에서 연다.
//
//   node harness/run.mjs regression   기존 하네스 출력이 harness/golden/regression.txt와 바이트 단위로 같은가
//   node harness/run.mjs colortheme   harness/colortheme.ts(색상 테마·설정 다이얼로그)가 두 엔진 모두 FAIL 0개인가
//   node harness/run.mjs muya         harness/muya-*.ts 전부에서 harness/required-muya.txt의 ID가
//                                     두 엔진 모두 PASS이고 FAIL이 0개인가
//   node harness/run.mjs ontop        harness/ontop-*.ts 전부에서 harness/required-ontop.txt의 ID가
//                                     두 엔진 모두 PASS이고 FAIL이 0개인가
//   node harness/run.mjs update       harness/update-*.ts 전부에서 harness/required-update.txt의 ID가
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

async function idsRun(prefix, requiredFile, label) {
  const names = readdirSync("harness")
    .filter((f) => new RegExp(`^${prefix}-.*\\.ts$`).test(f))
    .map((f) => f.replace(/\.ts$/, ""))
    .sort();
  const required = readFileSync(requiredFile, "utf8")
    .split("\n")
    .map((l) => l.match(/^([A-Z]\d{2})\s/)?.[1])
    .filter(Boolean);
  if (names.length === 0) {
    console.log(`FAIL  harness/${prefix}-*.ts 하네스가 하나도 없다`);
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
  console.log(bad === 0 ? `PASS  ${label} 하네스 전부 통과` : `FAIL  ${label} 하네스 문제 ${bad}건`);
  return bad === 0 ? 0 : 1;
}

// 최근 파일 다이얼로그. harness/required-recent.txt의 ID가 두 엔진 모두 PASS이고 FAIL이 0개인가.
async function recent() {
  const specs = ["recent.html?files=3", "recent.html?files=25", "recent.html?files=0"];
  const required = readFileSync("harness/required-recent.txt", "utf8")
    .split("\n")
    .map((l) => l.match(/^(R\d{2})\s/)?.[1])
    .filter(Boolean);
  generate(["recent"]);
  const results = await withServer((base) =>
    runSpecs(base, specs, { until: (t) => /(^|\n)DONE\s*$/.test(t), timeoutMs: 60000 }),
  );
  let bad = 0;
  for (const r of results) {
    console.log(`=== ${r.engine} ${r.spec}${r.timedOut ? "  (시간 초과 — DONE 없음)" : ""}\n${r.txt}`);
    if (r.timedOut) bad++;
  }
  for (const engine of ENGINES.map((e) => e.name())) {
    const lines = results.filter((r) => r.engine === engine).flatMap((r) => r.txt.split("\n"));
    const fails = lines.filter((l) => /^FAIL\b/.test(l));
    const passed = new Set(lines.map((l) => l.match(/^PASS\s+\[(R\d{2})\]/)?.[1]).filter(Boolean));
    const missing = required.filter((id) => !passed.has(id));
    console.log(`${engine}: 필수 ${required.length}개 중 PASS ${required.length - missing.length}개 · FAIL 줄 ${fails.length}개`);
    if (missing.length) console.log(`  PASS 없음: ${missing.join(" ")}`);
    bad += fails.length + missing.length;
  }
  console.log(bad === 0 ? "PASS  최근 파일 하네스 전부 통과" : `FAIL  최근 파일 하네스 문제 ${bad}건`);
  return bad === 0 ? 0 : 1;
}

// 세션 복원·설정 탭 하네스. harness/required-session.txt의 ID가 두 엔진 모두 PASS이고 FAIL이 0개인가.
async function session() {
  const specs = [
    "session.html?files=3",
    "session.html?files=0&seedSession=/tmp/a.md,/tmp/b.md,/tmp/c.md&seedActive=/tmp/b.md",
    "session.html?files=0&seedSession=/tmp/a.md,/tmp/b.md&restore=off",
    "session.html?files=2&seedSession=/tmp/x.md,/tmp/y.md",
    "session.html?files=0&seedSession=/tmp/a.md,/tmp/gone.md,/tmp/c.md&seedActive=/tmp/c.md&missing=/tmp/gone.md&seedRecent=/tmp/r1.md,/tmp/r2.md",
    "session.html?files=2&seedSession=/tmp/x.md&seedOther=/tmp/o.md",
    "session.html?files=0&seedSession=/tmp/a.md,/tmp/b.md,/tmp/c.md&seedActive=/tmp/b.md&seedLegacy=1",
    "session.html?files=0&seedSession=/tmp/a.md&seedActive=/tmp/a.md&seedOther=/tmp/o.md&closeWin=1",
  ];
  const required = readFileSync("harness/required-session.txt", "utf8")
    .split("\n")
    .map((l) => l.match(/^(S\d{2})\s/)?.[1])
    .filter(Boolean);
  generate(["session"]);
  const results = await withServer((base) =>
    runSpecs(base, specs, { until: (t) => /(^|\n)DONE\s*$/.test(t), timeoutMs: 60000 }),
  );
  let bad = 0;
  for (const r of results) {
    console.log(`=== ${r.engine} ${r.spec}${r.timedOut ? "  (시간 초과 — DONE 없음)" : ""}\n${r.txt}`);
    if (r.timedOut) bad++;
  }
  for (const engine of ENGINES.map((e) => e.name())) {
    const lines = results.filter((r) => r.engine === engine).flatMap((r) => r.txt.split("\n"));
    const fails = lines.filter((l) => /^FAIL\b/.test(l));
    const passed = new Set(lines.map((l) => l.match(/^PASS\s+\[(S\d{2})\]/)?.[1]).filter(Boolean));
    const missing = required.filter((id) => !passed.has(id));
    console.log(`${engine}: 필수 ${required.length}개 중 PASS ${required.length - missing.length}개 · FAIL 줄 ${fails.length}개`);
    if (missing.length) console.log(`  PASS 없음: ${missing.join(" ")}`);
    bad += fails.length + missing.length;
  }
  console.log(bad === 0 ? "PASS  세션 복원 하네스 전부 통과" : `FAIL  세션 복원 하네스 문제 ${bad}건`);
  return bad === 0 ? 0 : 1;
}

// 색상 테마·설정 다이얼로그 하네스. 끝나면 마지막 줄에 DONE을 쓰고, FAIL 줄이 하나도 없어야 통과다.
async function colortheme() {
  generate(["colortheme"]);
  const results = await withServer((base) =>
    runSpecs(base, ["colortheme.html?mermaid=1"], {
      until: (t) => /(^|\n)DONE\s*$/.test(t),
      timeoutMs: 90000,
    }),
  );
  let bad = 0;
  for (const r of results) {
    console.log(`=== ${r.engine} ${r.spec}${r.timedOut ? "  (시간 초과 — DONE 없음)" : ""}\n${r.txt}`);
    bad += (r.timedOut ? 1 : 0) + r.txt.split("\n").filter((l) => /^FAIL\b/.test(l)).length;
  }
  console.log(bad === 0 ? "PASS  색상 테마 하네스 전부 통과" : `FAIL  색상 테마 하네스 문제 ${bad}건`);
  return bad === 0 ? 0 : 1;
}

// ⌥+숫자 탭 전환 하네스. harness/required-tabkeys.txt의 ID가 두 엔진 모두 PASS이고 FAIL이 0개인가.
async function tabkeys() {
  const required = readFileSync("harness/required-tabkeys.txt", "utf8")
    .split("\n")
    .map((l) => l.match(/^(N\d{2})\s/)?.[1])
    .filter(Boolean);
  generate(["tabkeys"]);
  const results = await withServer((base) =>
    runSpecs(base, ["tabkeys.html?files=3"], { until: (t) => /(^|\n)DONE\s*$/.test(t), timeoutMs: 60000 }),
  );
  let bad = 0;
  for (const r of results) {
    console.log(`=== ${r.engine} ${r.spec}${r.timedOut ? "  (시간 초과 — DONE 없음)" : ""}\n${r.txt}`);
    if (r.timedOut) bad++;
  }
  for (const engine of ENGINES.map((e) => e.name())) {
    const lines = results.filter((r) => r.engine === engine).flatMap((r) => r.txt.split("\n"));
    const fails = lines.filter((l) => /^FAIL\b/.test(l));
    const passed = new Set(lines.map((l) => l.match(/^PASS\s+\[(N\d{2})\]/)?.[1]).filter(Boolean));
    const missing = required.filter((id) => !passed.has(id));
    console.log(`${engine}: 필수 ${required.length}개 중 PASS ${required.length - missing.length}개 · FAIL 줄 ${fails.length}개`);
    if (missing.length) console.log(`  PASS 없음: ${missing.join(" ")}`);
    bad += fails.length + missing.length;
  }
  console.log(bad === 0 ? "PASS  탭 전환 키 하네스 전부 통과" : `FAIL  탭 전환 키 하네스 문제 ${bad}건`);
  return bad === 0 ? 0 : 1;
}

// 탭 끌어서 순서 바꾸기 하네스. harness/required-tabdrag.txt의 ID가 두 엔진 모두 PASS이고 FAIL이 0개인가.
async function tabdrag() {
  const required = readFileSync("harness/required-tabdrag.txt", "utf8")
    .split("\n")
    .map((l) => l.match(/^(D\d{2})\s/)?.[1])
    .filter(Boolean);
  generate(["tabdrag"]);
  const results = await withServer((base) =>
    runSpecs(base, ["tabdrag.html?files=3"], { until: (t) => /(^|\n)DONE\s*$/.test(t), timeoutMs: 60000 }),
  );
  let bad = 0;
  for (const r of results) {
    console.log(`=== ${r.engine} ${r.spec}${r.timedOut ? "  (시간 초과 — DONE 없음)" : ""}\n${r.txt}`);
    if (r.timedOut) bad++;
  }
  for (const engine of ENGINES.map((e) => e.name())) {
    const lines = results.filter((r) => r.engine === engine).flatMap((r) => r.txt.split("\n"));
    const fails = lines.filter((l) => /^FAIL\b/.test(l));
    const passed = new Set(lines.map((l) => l.match(/^PASS\s+\[(D\d{2})\]/)?.[1]).filter(Boolean));
    const missing = required.filter((id) => !passed.has(id));
    console.log(`${engine}: 필수 ${required.length}개 중 PASS ${required.length - missing.length}개 · FAIL 줄 ${fails.length}개`);
    if (missing.length) console.log(`  PASS 없음: ${missing.join(" ")}`);
    bad += fails.length + missing.length;
  }
  console.log(bad === 0 ? "PASS  탭 끌기 하네스 전부 통과" : `FAIL  탭 끌기 하네스 문제 ${bad}건`);
  return bad === 0 ? 0 : 1;
}


// 다중 창·탭 분리 하네스. harness/required-windows.txt의 ID(W01~W14)가 두 엔진 모두 PASS이고 FAIL이 0개인가.
// 선택자 계약은 tabdrag와 같다. 아직 구현 안 된 검사는 harness/windows.ts에서 TODO FAIL로 남는다.
async function windows() {
  const required = readFileSync("harness/required-windows.txt", "utf8")
    .split("\n")
    .map((l) => l.match(/^(W\d{2})\s/)?.[1])
    .filter(Boolean);
  generate(["windows"]);
  const results = await withServer((base) =>
    runSpecs(base, ["windows.html?files=3", "windows.html?files=2&seedSession=/tmp/x.md,/tmp/y.md&windowInit=/tmp/harness-init.md"], { until: (t) => /(^|\n)DONE\s*$/.test(t), timeoutMs: 60000 }),
  );
  let bad = 0;
  for (const r of results) {
    console.log(`=== ${r.engine} ${r.spec}${r.timedOut ? "  (시간 초과 — DONE 없음)" : ""}\n${r.txt}`);
    if (r.timedOut) bad++;
  }
  for (const engine of ENGINES.map((e) => e.name())) {
    const lines = results.filter((r) => r.engine === engine).flatMap((r) => r.txt.split("\n"));
    const fails = lines.filter((l) => /^FAIL\b/.test(l));
    const passed = new Set(lines.map((l) => l.match(/^PASS\s+\[(W\d{2})\]/)?.[1]).filter(Boolean));
    const missing = required.filter((id) => !passed.has(id));
    console.log(`${engine}: 필수 ${required.length}개 중 PASS ${required.length - missing.length}개 · FAIL 줄 ${fails.length}개`);
    if (missing.length) console.log(`  PASS 없음: ${missing.join(" ")}`);
    bad += fails.length + missing.length;
  }
  console.log(bad === 0 ? "PASS  다중 창 하네스 전부 통과" : `FAIL  다중 창 하네스 문제 ${bad}건`);
  return bad === 0 ? 0 : 1;
}

const muya = () => idsRun("muya", "harness/required-muya.txt", "Muya");
const update = () => idsRun("update", "harness/required-update.txt", "업데이트");
const ontop = () => idsRun("ontop", "harness/required-ontop.txt", "항상 위");

// 문서 너비 4단계 하네스. harness/required-width.txt의 ID가 두 엔진 모두 PASS이고 FAIL이 0개인가.
async function width() {
  const required = readFileSync("harness/required-width.txt", "utf8")
    .split("\n")
    .map((l) => l.match(/^(W\d{2})\s/)?.[1])
    .filter(Boolean);
  generate(["docwidth"]);
  const results = await withServer((base) =>
    runSpecs(base, ["docwidth.html?files=1"], { until: (t) => /(^|\n)DONE\s*$/.test(t), timeoutMs: 90000 }),
  );
  let bad = 0;
  for (const r of results) {
    console.log(`=== ${r.engine} ${r.spec}${r.timedOut ? "  (시간 초과 — DONE 없음)" : ""}\n${r.txt}`);
    if (r.timedOut) bad++;
  }
  for (const engine of ENGINES.map((e) => e.name())) {
    const lines = results.filter((r) => r.engine === engine).flatMap((r) => r.txt.split("\n"));
    const fails = lines.filter((l) => /^FAIL\b/.test(l));
    const passed = new Set(lines.map((l) => l.match(/^PASS\s+\[(W\d{2})\]/)?.[1]).filter(Boolean));
    const missing = required.filter((id) => !passed.has(id));
    console.log(`${engine}: 필수 ${required.length}개 중 PASS ${required.length - missing.length}개 · FAIL 줄 ${fails.length}개`);
    if (missing.length) console.log(`  PASS 없음: ${missing.join(" ")}`);
    bad += fails.length + missing.length;
  }
  console.log(bad === 0 ? "PASS  문서 너비 하네스 전부 통과" : `FAIL  문서 너비 하네스 문제 ${bad}건`);
  return bad === 0 ? 0 : 1;
}



const mode = process.argv[2];
const modes = { regression, muya, update, ontop, recent, colortheme, session, tabkeys, tabdrag, width, windows };
if (!modes[mode]) {
  console.error("사용법: node harness/run.mjs <regression|muya|update|ontop|recent|colortheme|session|tabkeys|tabdrag|width|windows>");
  process.exit(64);
}
process.exit(await modes[mode]());

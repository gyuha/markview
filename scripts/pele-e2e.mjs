// mermaid 렌더가 pele를 먼저 쓰고, 실패하면 mermaid로 폴백하는지 실제 브라우저(Chromium·WebKit)에서 판정한다.
//
//   node scripts/pele-e2e.mjs      FAIL이 하나라도 있으면 종료코드 1
//
// 강제 실패는 프로덕션 코드에 훅을 두지 않고, 개발 서버가 내주는 pele/mermaid 모듈 요청을
// Playwright 라우트로 던지는 스텁에 바꿔치기해서 만든다. 그래서 "pele 경로를 끈" 상태가 P3에서 그대로 재현되고,
// P3이 `svg.pele 가 아니다`를 단정하므로 pele 경로가 죽으면 P1이 실패한다는 증명도 겸한다.
import { createServer as createNetServer } from "node:net";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "vite";
import { chromium, webkit } from "playwright";

const ENGINES = [chromium, webkit];
const PELE_DEP = /\/node_modules\/\.vite\/deps\/pele\.js/;
const MERMAID_DEP = /\/node_modules\/\.vite\/deps\/mermaid\.js/;
const THROW_PELE = "export const render = () => { throw new Error('forced pele failure'); };";
const THROW_MERMAID =
  "export default { initialize() {}, parse() { throw new Error('forced mermaid failure'); }, render() { throw new Error('forced mermaid failure'); } };";

let failures = 0;
function check(engine, name, ok, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  [${engine}] ${name}${ok || !detail ? "" : `  ${detail}`}`);
}

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

/** index.html에 Tauri IPC 모킹만 끼운 페이지. ?mermaid=1 이면 `graph TD; A-->B;` 블록이 든 문서가 열린다. */
function writePage() {
  const html = readFileSync("index.html", "utf8").replace(
    '<script type="module" src="/src/main.ts" defer></script>',
    '<script src="/harness/mock-tauri.js"></script>\n    <script type="module" src="/src/main.ts" defer></script>',
  );
  mkdirSync("harness/.generated", { recursive: true });
  writeFileSync("harness/.generated/pele-e2e.html", html);
}

/** 새 페이지를 열고 `.mermaid-block`이 내용을 가질 때까지 기다린다. 요청된 모듈 URL도 모은다. */
async function open(browser, base, { stubPele = false, stubMermaid = false } = {}) {
  const page = await browser.newPage();
  const requests = [];
  page.on("request", (r) => requests.push(r.url()));
  if (stubPele) {
    await page.route(PELE_DEP, (route) =>
      route.fulfill({ contentType: "text/javascript", body: THROW_PELE }),
    );
  }
  if (stubMermaid) {
    await page.route(MERMAID_DEP, (route) =>
      route.fulfill({ contentType: "text/javascript", body: THROW_MERMAID }),
    );
  }
  await page.goto(`${base}/harness/.generated/pele-e2e.html?mermaid=1`);
  await page.waitForFunction(
    () => {
      const b = document.querySelector(".mermaid-block");
      return !!b && (b.querySelector("svg") !== null || b.classList.contains("mermaid-failed"));
    },
    null,
    { timeout: 30000 },
  );
  return { page, requests };
}

const mermaidRequested = (requests) => requests.some((u) => MERMAID_DEP.test(u));

async function previewScenarios(engine, browser, base) {
  // P1 — pele가 그리고 mermaid 번들은 요청조차 되지 않는다.
  {
    const { page, requests } = await open(browser, base);
    const isPele = await page.evaluate(() => !!document.querySelector(".mermaid-block svg.pele"));
    check(engine, "P1 미리보기: .mermaid-block svg.pele 로 그려진다", isPele);
    check(engine, "P1 미리보기: mermaid 번들 요청 0건", !mermaidRequested(requests), requests.filter((u) => MERMAID_DEP.test(u)).join(","));

    // P2 — 다크로 전환하면 다크 기본 테마(github-dark)의 파랑으로 다시 그려진다.
    const blue = await page.evaluate(async () => {
      const { COLOR_THEMES } = await import("/src/themes.generated.ts");
      return COLOR_THEMES.find((t) => t.id === "github-dark").normal.blue.toLowerCase();
    });
    await page.evaluate(() => {
      document.querySelector("#settings-button").click();
    });
    await page.waitForSelector(".settings [data-mode-choice='dark']");
    await page.evaluate(() => document.querySelector(".settings [data-mode-choice='dark']").click());
    const redrawn = await page
      .waitForFunction(
        (b) => {
          const svg = document.querySelector(".mermaid-block svg.pele");
          return !!svg && svg.outerHTML.toLowerCase().includes(b);
        },
        blue,
        { timeout: 30000 },
      )
      .then(() => true, () => false);
    check(engine, "P2 미리보기: 테마를 바꾸면 pele SVG가 새 팔레트 파랑으로 다시 그려진다", redrawn);
    await page.close();
  }

  // P3 — pele가 던지면 mermaid로 폴백해 그려지고 실패 배지는 없다.
  {
    const { page } = await open(browser, base, { stubPele: true });
    const r = await page.evaluate(() => {
      const b = document.querySelector(".mermaid-block");
      return {
        svg: !!b.querySelector("svg"),
        pele: !!b.querySelector("svg.pele"),
        failed: b.classList.contains("mermaid-failed"),
      };
    });
    check(engine, "P3 미리보기 폴백: pele가 실패하면 mermaid SVG가 그려진다 (pele 아님, 실패 배지 없음)", r.svg && !r.pele && !r.failed, JSON.stringify(r));
    await page.close();
  }

  // P4 — 둘 다 실패하면 기존대로 배지 + 원문 코드블록.
  {
    const { page } = await open(browser, base, { stubPele: true, stubMermaid: true });
    const r = await page.evaluate(() => {
      const b = document.querySelector(".mermaid-block");
      return {
        failed: b.classList.contains("mermaid-failed"),
        badge: !!b.querySelector(".mermaid-error"),
        source: b.querySelector("pre code")?.textContent ?? "",
        svg: !!b.querySelector("svg"),
      };
    });
    check(
      engine,
      "P4 둘 다 실패: .mermaid-failed + 오류 배지 + 원문 코드블록",
      r.failed && r.badge && r.source.includes("A-->B") && !r.svg,
      JSON.stringify(r),
    );
    await page.close();
  }
}

/** 편집 모드(Muya)로 들어가 `.mu-diagram-preview` 안의 SVG가 나타날 때까지 기다린다. */
async function openEditMode(browser, base, opts) {
  const page = await browser.newPage();
  const requests = [];
  page.on("request", (r) => requests.push(r.url()));
  if (opts.stubPele) {
    await page.route(PELE_DEP, (route) => route.fulfill({ contentType: "text/javascript", body: THROW_PELE }));
  }
  await page.goto(`${base}/harness/.generated/pele-e2e.html?mermaid=1`);
  await page.waitForSelector(".mermaid-block svg", { timeout: 30000 });
  await page.evaluate(() => document.querySelector('#view-mode [data-mode="edit"]').click());
  await page.waitForSelector(".mu-diagram-preview svg, [class*=diagram] svg", { timeout: 30000 });
  return { page, requests };
}

async function editScenarios(engine, browser, base) {
  // P5 — 편집 모드에서도 pele가 그리고, 이 페이지에서 mermaid 번들은 요청되지 않는다.
  // (미리보기도 pele로 그리므로 문서 전체에서 mermaid 요청이 0건이어야 한다.)
  {
    const { page, requests } = await openEditMode(browser, base, {});
    const isPele = await page.evaluate(
      () => !!document.querySelector(".mu-diagram-preview svg.pele, [class*=diagram] svg.pele"),
    );
    check(engine, "P5 편집 모드: Muya 다이어그램이 svg.pele 로 그려진다", isPele);
    check(engine, "P5 편집 모드: mermaid 번들 요청 0건", !mermaidRequested(requests), requests.filter((u) => MERMAID_DEP.test(u)).join(","));
    await page.close();
  }

  // P6 — pele가 던지면 Muya도 mermaid로 폴백해 SVG를 그린다.
  {
    const { page } = await openEditMode(browser, base, { stubPele: true });
    const r = await page.evaluate(() => {
      const svg = document.querySelector(".mu-diagram-preview svg, [class*=diagram] svg");
      return { svg: !!svg, pele: !!svg?.classList.contains("pele") };
    });
    check(engine, "P6 편집 모드 폴백: pele가 실패하면 mermaid SVG가 그려진다 (pele 아님)", r.svg && !r.pele, JSON.stringify(r));
    await page.close();
  }
}

async function main() {
  writePage();
  const port = await freePort();
  const server = await createServer({
    logLevel: "silent",
    clearScreen: false,
    server: { port, strictPort: true, hmr: false },
  });
  await server.listen();
  const base = `http://localhost:${port}`;
  try {
    for (const engine of ENGINES) {
      const browser = await engine.launch();
      try {
        await previewScenarios(engine.name(), browser, base);
        await editScenarios(engine.name(), browser, base);
      } finally {
        await browser.close();
      }
    }
  } finally {
    await server.close();
  }
  console.log(failures === 0 ? "PASS  pele e2e 전부 통과" : `FAIL  pele e2e 실패 ${failures}건`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

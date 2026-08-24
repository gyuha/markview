// index.html을 그대로 읽어 Tauri IPC 모킹과 측정 스크립트를 끼운 하네스 페이지를 만든다.
// 사본을 저장소에 두면 마크업이 바뀔 때 조용히 표류해 낡은 마크업 위에서 통과하는
// 거짓 테스트가 되므로, 실행할 때마다 생성한다.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const names = process.argv.slice(2);
if (names.length === 0) {
  console.error("사용법: node harness/build-mocked.mjs <이름>...  (harness/<이름>.ts 가 있어야 한다)");
  process.exit(1);
}

const src = readFileSync("index.html", "utf8");
mkdirSync("harness/.generated", { recursive: true });

for (const name of names) {
  const html = src
    .replace(
      '<script type="module" src="/src/main.ts" defer></script>',
      '<script src="/harness/mock-tauri.js"></script>\n' +
        '    <script type="module" src="/src/main.ts" defer></script>',
    )
    .replace(
      "</body>",
      `  <pre id="out"></pre>\n    <script type="module" src="/harness/${name}.ts"></script>\n  </body>`,
    );
  const out = `harness/.generated/${name}.html`;
  writeFileSync(out, html);
  console.log(`${out}  →  pnpm dev 후 http://localhost:1420/${out} 의 #out 을 읽는다`);
}

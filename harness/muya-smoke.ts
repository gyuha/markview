// Muya 스모크 — 이식한 엔진(vendor/muya)이 이 앱의 빌드로 실제로 뜨는지 본다.
// `node harness/run.mjs muya`가 Chromium·WebKit에서 돌린다. 필수 ID는 없다(엔진 연결은 2of6).
import { Muya } from "../vendor/muya/src/index";

const out = document.querySelector<HTMLElement>("#out")!;
const lines: string[] = [];

function check(ok: boolean, label: string, detail = ""): void {
  lines.push(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
}

const SOURCE = "# 제목\n\n본문 한 줄\n";

try {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const muya = new Muya(host, { markdown: SOURCE });
  muya.init();

  const headings = [...muya.domNode.querySelectorAll("h1")];
  check(headings.length === 1, "스모크: `# 제목`이 h1 하나로 렌더된다", `h1=${headings.length}`);
  // Muya는 `#` 같은 문법 기호를 DOM에 남기고(.mu-remove) 커서가 없을 때 CSS로 숨긴다 —
  // 기호를 뺀 내용이 제목이어야 한다.
  const content = headings[0]?.querySelector(".mu-content")?.cloneNode(true) as HTMLElement | undefined;
  content?.querySelectorAll(".mu-remove").forEach((el) => el.remove());
  check(content?.textContent === "제목", "스모크: 문법 기호를 뺀 h1 내용", JSON.stringify(content?.textContent ?? null));
  check(
    muya.getMarkdown() === SOURCE,
    "스모크: 편집 없이 getMarkdown()이 원문과 같다",
    JSON.stringify(muya.getMarkdown()),
  );
  muya.destroy();
} catch (error) {
  check(false, "스모크: Muya 로드·생성", String(error));
}

lines.push("DONE");
out.textContent = lines.join("\n");

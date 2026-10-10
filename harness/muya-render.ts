// 편집 전용 모드의 Muya 렌더(R01–R06). 문서는 /fixtures/doc.md 탭으로 열어 상대 경로 이미지
// `logo.png`가 개발 서버의 fixtures/logo.png로 실제로 로드되게 한다. 픽스처는 이 하네스가 스스로 넣는다.
import {
  check,
  clickMode,
  contentText,
  guard,
  injectViaSplit,
  muyaOf,
  openTab,
  ready,
  waitFor,
} from "./lib-muya";

const RENDER_DOC = [
  "---",
  "title: 시험",
  "---",
  "",
  "# 제목 하나",
  "",
  "## 제목 둘",
  "",
  "**굵게** *기울임* ~~취소~~ `코드` [링크](https://example.com)",
  "",
  "- 글머리",
  "",
  "1. 번호",
  "",
  "- [ ] 할 일",
  "",
  "> 인용",
  "",
  "---",
  "",
  "| 가 | 나 |",
  "| - | - |",
  "| 1 | 2 |",
  "",
  "```js",
  "const answer = 42;",
  "```",
  "",
  "```python",
  "def greet(name):",
  "    return name",
  "```",
  "",
  "인라인 $a+b$ 수식",
  "",
  "$$",
  "x^2",
  "$$",
  "",
  "```mermaid",
  "graph TD",
  "  A --> B",
  "```",
  "",
  "![로고](logo.png)",
  "",
].join("\n");

const DOC_PATH = "/fixtures/doc.md";

await guard(async () => {
  if (!(await ready())) return check("", "탭이 열렸다", false);
  const tab = await openTab(DOC_PATH);
  injectViaSplit(RENDER_DOC);
  clickMode("edit");
  const muya = await muyaOf(tab);
  if (!muya) return check("", "Muya가 만들어졌다", false);
  const root = muya.domNode;
  const all = (sel: string) => [...root.querySelectorAll(sel)];
  const has = (sel: string, text: string) => all(sel).some((el) => contentText(el)?.includes(text));
  // 수식·다이어그램·이미지는 비동기로 그려진다.
  await waitFor(() => root.querySelectorAll(".katex").length >= 2, 10000);
  await waitFor(() => root.querySelector('img[src*="logo.png"]'), 10000);
  await waitFor(() => root.querySelector(".mu-diagram-preview svg, [class*=diagram] svg"), 10000);

  const r01 = {
    h1: has("h1", "제목 하나"),
    h2: has("h2", "제목 둘"),
    strong: has("strong", "굵게"),
    em: has("em", "기울임"),
    del: has("del", "취소"),
    code: has("p code", "코드"),
    // 편집 화면의 링크는 <a>가 아니라 span.mu-link[href]다(MarkText DOM).
    link: has('.mu-link[href="https://example.com"]', "링크"),
  };
  check("R01", "제목·굵게·기울임·취소선·인라인 코드·링크가 각 요소로 렌더", Object.values(r01).every(Boolean), JSON.stringify(r01));

  // Muya는 구분선을 <hr>이 아니라 p.mu-thematic-break 블록으로, 표 머리글을 첫 행 td로 그린다(MarkText DOM).
  const firstRowCells = root.querySelectorAll("figure.mu-table table tr:first-child td").length;
  const r02 = {
    ul: has("ul", "글머리"),
    ol: has("ol", "번호"),
    checkbox: all('input[type="checkbox"]').length >= 1 && has("ul", "할 일"),
    blockquote: has("blockquote", "인용"),
    rule: all(".mu-thematic-break").length >= 1,
    table: firstRowCells >= 2 && has("figure.mu-table", "가"),
  };
  check("R02", "리스트 3종·인용·구분선·표(머리 셀 2개 이상)", Object.values(r02).every(Boolean), JSON.stringify(r02));

  // js는 Prism에 미리 들어 있고 python은 동적으로 불러온다 — 언어 문법 로딩까지 본다.
  const blockTokens = (lang: string) =>
    all("pre.mu-code-block")
      .find((pre) => pre.querySelector(".mu-language-input")?.textContent === lang)
      ?.querySelectorAll(".token").length ?? 0;
  await waitFor(() => blockTokens("python") > 0, 10000);
  const js = blockTokens("js");
  const python = blockTokens("python");
  check("R03", "```js 코드블록이 Prism 토큰으로 하이라이트(동적 로드 언어 python 포함)", js >= 1 && python >= 1, `js=${js} python=${python}`);

  const inlineMath = root.querySelectorAll(".mu-paragraph .katex").length;
  const blockMath = root.querySelectorAll(".katex").length - inlineMath;
  const mermaidSvg = !!root.querySelector(".mu-diagram-preview svg, [class*=diagram] svg");
  check(
    "R04",
    "인라인·블록 수식이 KaTeX로, mermaid가 svg로",
    inlineMath >= 1 && blockMath >= 1 && mermaidSvg,
    `inline=${inlineMath} block=${blockMath} mermaid=${mermaidSvg}`,
  );

  const firstBlock = root.querySelector(".mu-container")?.firstElementChild;
  const leaked = all("p").some((p) => (p.textContent ?? "").includes("title: 시험"));
  check(
    "R05",
    "front matter가 맨 앞 front matter 블록이고 본문 문단으로 새지 않는다",
    !!firstBlock?.matches("pre.mu-frontmatter") && !leaked,
    `first=${firstBlock?.className} leaked=${leaked}`,
  );

  const img = root.querySelector<HTMLImageElement>('img[src*="logo.png"]');
  const src = img?.getAttribute("src") ?? null;
  const convert = (window as unknown as { __TAURI_INTERNALS__: { convertFileSrc: (p: string) => string } })
    .__TAURI_INTERNALS__.convertFileSrc;
  const want = convert("/fixtures/logo.png");
  check(
    "R06",
    "상대 경로 이미지 src = 문서 폴더 기준 절대 경로의 convertFileSrc 값(file:// 아님)",
    src === want && !/^file:/i.test(src ?? ""),
    `src=${JSON.stringify(src)} want=${JSON.stringify(want)}`,
  );
});

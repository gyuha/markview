import MarkdownIt from "markdown-it";
import anchor from "markdown-it-anchor";
// @ts-expect-error 이 플러그인은 타입 선언을 제공하지 않는다
import taskLists from "markdown-it-task-lists";
import frontMatter from "markdown-it-front-matter";
import DOMPurify from "dompurify";
import hljs from "highlight.js";
import { convertFileSrc } from "@tauri-apps/api/core";

/**
 * markdown-it 인스턴스.
 * html:true 는 의도된 선택이고, 그래서 삽입 전에 반드시 DOMPurify를 통과한다.
 * (.forge/adr/260822-222214-raw-html-sanitized.md)
 */
const md = new MarkdownIt({
  html: true,
  linkify: true,
  highlight(code, lang) {
    // mermaid 코드블록은 3of3이 SVG로 바꿔야 하므로 하이라이팅하지 않고 원문을 남긴다.
    if (lang === "mermaid") return "";
    if (lang && hljs.getLanguage(lang)) {
      try {
        const html = hljs.highlight(code, { language: lang }).value;
        return `<pre class="hljs"><code class="language-${lang}">${html}</code></pre>`;
      } catch {
        // 하이라이팅 실패는 렌더 실패가 아니다 — 기본 이스케이프로 떨어진다.
      }
    }
    return "";
  },
});

/**
 * 블록마다 원문 시작 줄을 `data-line`으로 남긴다 — 분할 모드 스크롤 동기화의 앵커다.
 * `token.map`은 top-level 블록과 목록 항목에 있고, 목록 항목까지 심는 이유는 긴 목록이
 * 앵커 하나가 되면 그 안에서 비율 보간으로 되돌아가 어긋나기 때문이다.
 */
md.core.ruler.push("line-anchors", (state) => {
  for (const token of state.tokens) {
    if (token.nesting === 1 && token.map) token.attrSet("data-line", String(token.map[0]));
  }
});

/**
 * fence는 위 core 룰로 덮을 수 없다. markdown-it의 fence 규칙은 highlight가 완성된 `<pre>`를
 * 돌려주면 그것을 그대로 반환하고(토큰 속성 무시), 아니면 속성을 `<code>`에 붙인다 — 어느 쪽도
 * `<pre>`에 앵커를 남기지 않는다. 그래서 결과 HTML의 바깥 태그에 직접 끼운다.
 */
const defaultFence = md.renderer.rules.fence!;
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const html = defaultFence(tokens, idx, options, env, self);
  const line = tokens[idx].map?.[0];
  return line == null ? html : html.replace("<pre", `<pre data-line="${line}"`);
};

md.use(anchor);
md.use(taskLists, { enabled: false, label: true });
// frontmatter는 콜백으로 넘겨받고 출력에서는 제거된다. 지금은 쓰지 않는다.
md.use(frontMatter, () => {});

/** POSIX 경로 기준 부모 디렉터리. macOS 단독 결정에 따라 Windows 구분자는 다루지 않는다. */
export function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

/** 문서 경로 기준으로 상대 경로를 절대 경로로 만든다. */
export function resolvePath(baseDir: string, relative: string): string {
  if (relative.startsWith("/")) return relative;
  const parts = `${baseDir}/${relative}`.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
}

const EXTERNAL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

export function isExternalHref(href: string): boolean {
  return EXTERNAL_SCHEME.test(href) && !href.startsWith("asset:");
}

/**
 * 마크다운 문자열을 sanitize된 HTML로 만들어 컨테이너에 넣고,
 * 그 DOM에서 상대 경로 이미지를 asset protocol URL로 바꾼다.
 */
export function renderInto(container: HTMLElement, markdown: string, docPath: string): void {
  const dirty = md.render(markdown);
  container.innerHTML = DOMPurify.sanitize(dirty);
  rewriteRelativeImages(container, dirname(docPath));
  extractMermaidBlocks(container);
  addCopyButtons(container);
}

/** 두 아이콘을 함께 넣고 CSS가 `data-copied`로 하나만 보인다. 툴바와 같은 인라인 SVG 방식. */
const COPY_ICONS =
  '<svg class="icon-copy" viewBox="0 0 24 24" aria-hidden="true">' +
  '<rect x="9" y="9" width="11" height="11" rx="2" />' +
  '<path d="M5 15V5a2 2 0 0 1 2-2h8" /></svg>' +
  '<svg class="icon-check" viewBox="0 0 24 24" aria-hidden="true">' +
  '<path d="M5 13l4 4L19 7" /></svg>';

/**
 * 코드블록마다 복사 버튼을 단다. mermaid 추출 **뒤에** 도는 것이 중요하다 —
 * 앞에서 돌면 곧 `<div>`로 치환돼 버려질 `<pre>`에도 버튼을 붙이는 헛일이 된다.
 * sanitize 이후라 여기서 만드는 요소는 DOMPurify에 지워지지 않는다.
 */
function addCopyButtons(container: HTMLElement): void {
  for (const pre of Array.from(container.querySelectorAll("pre"))) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "copy-btn";
    button.setAttribute("aria-label", "코드 복사");
    button.title = "복사";
    button.innerHTML = COPY_ICONS;
    pre.prepend(button);
  }
}

/**
 * mermaid 코드블록을 자리표시자로 바꾸고 원문을 `data-mermaid`에 보관한다.
 * SVG로 바꿔치기하면 원문이 DOM에서 사라져 테마 변경 시 다시 그릴 수 없다.
 * sanitize 이후에 실행되므로 여기서 붙이는 속성은 우리가 만든 값이다.
 */
function extractMermaidBlocks(container: HTMLElement): void {
  for (const code of Array.from(container.querySelectorAll("pre > code.language-mermaid"))) {
    const pre = code.parentElement;
    if (!pre) continue;
    const holder = document.createElement("div");
    holder.className = "mermaid-block";
    holder.dataset.mermaid = code.textContent ?? "";
    // `<pre>`를 버리면 그 위의 스크롤 앵커도 같이 사라진다 — 옮겨 담는다.
    const line = pre.getAttribute("data-line");
    if (line !== null) holder.dataset.line = line;
    pre.replaceWith(holder);
  }
}

function rewriteRelativeImages(container: HTMLElement, baseDir: string): void {
  for (const img of Array.from(container.querySelectorAll("img"))) {
    const src = img.getAttribute("src");
    if (!src || isExternalHref(src) || src.startsWith("data:")) continue;
    img.setAttribute("src", convertFileSrc(resolvePath(baseDir, src)));
  }
}

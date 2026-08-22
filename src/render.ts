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

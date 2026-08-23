import type { Effective } from "./theme";

type MermaidApi = Awaited<typeof import("mermaid")>["default"];

let mermaidApi: MermaidApi | null = null;
let initializedFor: Effective | null = null;
let idSeq = 0;

/**
 * `테마\n원문` → 렌더된 SVG.
 * 편집 중에는 문서가 통째로 다시 렌더되므로 자리표시자가 매번 새로 생기는데,
 * 원문이 그대로인 다이어그램을 다시 그리면 타이핑이 즉시 막힌다. 캐시가 그것을 막는다.
 */
const svgCache = new Map<string, string>();

/** 번들을 실제로 mermaid가 필요한 순간까지 미룬다. */
async function load(theme: Effective): Promise<MermaidApi> {
  if (!mermaidApi) {
    mermaidApi = (await import("mermaid")).default;
  }
  if (initializedFor !== theme) {
    mermaidApi.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      // 이게 없으면 파싱 실패 시 mermaid가 "Syntax error" 폭탄 그래픽을 document.body에
      // 직접 붙이고, 테마를 전환할 때마다 하나씩 누적된다.
      suppressErrorRendering: true,
      theme: theme === "dark" ? "dark" : "default",
    });
    initializedFor = theme;
  }
  return mermaidApi;
}

/**
 * 컨테이너 안의 mermaid 자리표시자를 전수 렌더한다.
 * 원문은 `data-mermaid`에 남아 있으므로 테마가 바뀌면 몇 번이든 다시 그릴 수 있다.
 */
export async function renderMermaid(scope: HTMLElement, theme: Effective): Promise<void> {
  const blocks = Array.from(scope.querySelectorAll<HTMLElement>(".mermaid-block"));
  if (blocks.length === 0) return;

  const mermaid = await load(theme);

  for (const block of blocks) {
    const source = block.dataset.mermaid ?? "";
    const cacheKey = `${theme}\n${source}`;
    const cached = svgCache.get(cacheKey);
    if (cached !== undefined) {
      block.classList.remove("mermaid-failed");
      block.innerHTML = cached;
      continue;
    }
    const id = `mermaid-${idSeq++}`;
    try {
      const { svg } = await mermaid.render(id, source);
      block.classList.remove("mermaid-failed");
      block.innerHTML = svg;
      svgCache.set(cacheKey, svg);
    } catch (e) {
      // 성공 경로에서는 부르지 않는다 — 성공한 SVG의 id가 이 id와 같아서 방금 넣은 것을 지운다.
      discardStrayNodes(id);
      renderFailure(block, source, e);
    }
  }
}

/** mermaid가 렌더 중 body에 직접 만들어둔 임시 노드만 치운다. 문서 안의 정상 SVG는 건드리지 않는다. */
function discardStrayNodes(id: string): void {
  for (const strayId of [id, `d${id}`]) {
    const node = document.getElementById(strayId);
    if (node?.parentElement === document.body) node.remove();
  }
}

/** 실패하면 원문 코드블록으로 되돌리고 한 줄 배지를 붙인다. 방치하면 정체불명의 에러 SVG가 남는다. */
function renderFailure(block: HTMLElement, source: string, error: unknown): void {
  block.classList.add("mermaid-failed");
  block.textContent = "";

  const badge = document.createElement("p");
  badge.className = "mermaid-error";
  badge.textContent = `다이어그램 렌더 실패: ${String(error).split("\n")[0]}`;

  const pre = document.createElement("pre");
  const code = document.createElement("code");
  code.textContent = source;
  pre.appendChild(code);

  block.append(badge, pre);
}

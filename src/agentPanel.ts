/**
 * AI 에이전트 패널 — 프리셋을 고르고 지시를 보내, 돌아온 결과를 diff로 검토한 뒤 수락하거나 거절한다.
 * 에이전트는 Rust가 임시 사본에서 돌린다(ADR 261022-230253). 이 모듈은 문서 파일을 읽거나 쓰지 않는다 —
 * 수락해도 원문만 바뀌고 저장은 사용자가 기존 방식으로 한다.
 *
 * main.ts가 처음 패널을 열 때 동적으로 불러온다(초기 로드 JS 한도).
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import diff from "fast-diff";
import {
  AGENTS_CHANGED_EVENT,
  QUICK_ACTIONS_EVENT,
  isQuickActionsStorageKey,
  readQuickActions,
  type DetectedAgent,
} from "./agentConfig";

/** 패널이 main.ts에 기대는 동작. */
export interface AgentHost {
  activePath(): string | null;
  /** 편집기에 남은 입력까지 밀어낸 현재 원문. 탭이 없으면 null. */
  source(path: string): string | null;
  /** 편집기에서 지금 고른 글자(마크다운 원문). 고른 것이 없거나 읽을 수 없는 모드면 빈 문자열. */
  selection(path: string): string;
  /** 밀어내지 않고 보는 원문 — 수락 가능 여부를 계속 확인하는 데 쓴다. */
  peek(path: string): string | null;
  /** 원문을 바꾸고 두 편집기와 프리뷰에 반영한다(수정됨 표시 포함). 저장하지 않는다. */
  apply(path: string, text: string): Promise<void>;
}

type Phase = "idle" | "running" | "review";

interface Row {
  kind: "add" | "del" | "eq" | "gap";
  line: string;
}

/** 탭별 상태. 다른 탭으로 가도 실행은 계속되고, 돌아오면 그대로 보인다. */
interface TabState {
  phase: Phase;
  prompt: string;
  log: string[];
  error: string | null;
  /** 실행을 시작한 시점의 원문 — 수락할 때 현재 원문과 같아야 한다. */
  snapshot: string;
  result: string;
  rows: Row[];
  /** 지시와 함께 보낼, 사용자가 편집기에서 고른 글자. 패널을 누르는 순간 읽는다. */
  selection: string;
  cancelRequested: boolean;
  /** 늦게 도착한 이전 실행의 결과를 버리는 번호. */
  run: number;
}

/** 선택 미리보기에 보여 줄 최대 글자 수. */
const MAX_SELECTION_PREVIEW = 160;
const MAX_LOG_LINES = 500;
/** 바뀐 줄 앞뒤로 보여 줄 같은 줄 수. 나머지는 접는다. */
const CONTEXT_LINES = 2;
/** 줄 하나를 글자 하나로 바꿔 diff하는데, 서로 다른 줄이 이보다 많으면 통째로 바꾼 것으로 보여 준다. */
const MAX_DISTINCT_LINES = 6000;

/** 줄 단위 diff. fast-diff는 글자 단위라, 서로 다른 줄마다 글자 하나를 배정해 그 글자열을 비교한다. */
export function lineDiff(before: string, after: string): Row[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const code = new Map<string, string>();
  const lines: string[] = [];
  const encode = (list: string[]) =>
    list
      .map((line) => {
        let c = code.get(line);
        if (c === undefined) {
          c = String.fromCharCode(0xe000 + code.size);
          code.set(line, c);
          lines.push(line);
        }
        return c;
      })
      .join("");
  const rows: Row[] = [];
  if (new Set([...a, ...b]).size > MAX_DISTINCT_LINES) {
    for (const line of a) rows.push({ kind: "del", line });
    for (const line of b) rows.push({ kind: "add", line });
    return rows;
  }
  const kinds = { [-1]: "del", [0]: "eq", [1]: "add" } as const;
  for (const [op, text] of diff(encode(a), encode(b))) {
    for (const ch of text) rows.push({ kind: kinds[op as -1 | 0 | 1], line: lines[ch.charCodeAt(0) - 0xe000] });
  }
  return collapse(rows);
}

/** 바뀐 줄에서 먼 같은 줄은 접는다. */
function collapse(rows: Row[]): Row[] {
  const keep = rows.map((r) => r.kind !== "eq");
  const near = keep.map((_, i) => {
    for (let d = -CONTEXT_LINES; d <= CONTEXT_LINES; d++) if (keep[i + d]) return true;
    return false;
  });
  const out: Row[] = [];
  let hidden = 0;
  rows.forEach((row, i) => {
    if (near[i]) {
      if (hidden) out.push({ kind: "gap", line: `⋯ ${hidden}줄` });
      hidden = 0;
      out.push(row);
    } else hidden++;
  });
  if (hidden) out.push({ kind: "gap", line: `⋯ ${hidden}줄` });
  return out;
}

export interface AgentPanel {
  show(): void;
  hide(): void;
  /** 활성 탭이 바뀌었을 때 그 탭의 상태로 다시 그린다. */
  refresh(): void;
  /** 탭이 닫혔다. 실행 중이면 취소한다. */
  forget(path: string): void;
}

export function createAgentPanel(root: HTMLElement, host: AgentHost, onClose: () => void): AgentPanel {
  const states = new Map<string, TabState>();
  let agents: DetectedAgent[] | null = null;
  let detecting = false;

  root.innerHTML = `
    <header class="agent-head">
      <strong>에이전트</strong>
      <select data-agent-preset aria-label="에이전트 선택"></select>
      <button type="button" class="agent-close" data-agent-close aria-label="패널 닫기" title="닫기">×</button>
    </header>
    <p class="agent-empty" data-agent-empty hidden>사용할 수 있는 에이전트를 찾지 못했습니다. Claude Code, Codex, OpenCode 중 하나를 설치하고 터미널에서 실행되는지 확인하세요.</p>
    <div class="agent-log" data-agent-log role="log" aria-live="polite"></div>
    <p class="agent-error" data-agent-error role="alert" hidden></p>
    <section class="agent-review" data-agent-review hidden>
      <p class="agent-note" data-agent-stale hidden>실행하는 동안 문서가 바뀌었습니다. 결과를 수락할 수 없습니다 — 버리거나 지금 문서로 다시 실행하세요.</p>
      <p class="agent-note" data-agent-nochange hidden>변경 없음 — 에이전트가 문서를 바꾸지 않았습니다.</p>
      <div class="agent-diff" data-agent-diff></div>
      <div class="agent-actions">
        <button type="button" data-agent-accept>수락</button>
        <button type="button" data-agent-reject>거절</button>
        <button type="button" data-agent-discard>결과 버리기</button>
        <button type="button" data-agent-rerun>다시 실행</button>
      </div>
    </section>
    <footer class="agent-foot">
      <div class="agent-chips" data-agent-chips></div>
      <div class="agent-selection" data-agent-selection hidden>
        <span data-agent-selection-text></span>
        <button type="button" data-agent-selection-clear aria-label="선택 해제" title="선택 해제">×</button>
      </div>
      <textarea data-agent-prompt rows="3" placeholder="문서를 어떻게 고칠지 적으세요" aria-label="지시"></textarea>
      <div class="agent-actions">
        <button type="button" data-agent-send>보내기</button>
        <button type="button" data-agent-cancel>취소</button>
      </div>
    </footer>`;

  const $ = <T extends HTMLElement>(name: string) => root.querySelector<T>(`[data-agent-${name}]`)!;
  const select = $<HTMLSelectElement>("preset");
  const empty = $("empty");
  const logEl = $("log");
  const errorEl = $("error");
  const review = $("review");
  const stale = $("stale");
  const nochange = $("nochange");
  const diffEl = $("diff");
  const prompt = $<HTMLTextAreaElement>("prompt");
  const chipsEl = $("chips");
  const selectionEl = $("selection");
  const selectionText = $("selection-text");
  const btn = {
    send: $<HTMLButtonElement>("send"),
    cancel: $<HTMLButtonElement>("cancel"),
    accept: $<HTMLButtonElement>("accept"),
    reject: $<HTMLButtonElement>("reject"),
    discard: $<HTMLButtonElement>("discard"),
    rerun: $<HTMLButtonElement>("rerun"),
  };

  const stateOf = (path: string): TabState => {
    let st = states.get(path);
    if (!st) {
      st = { phase: "idle", prompt: "", log: [], error: null, snapshot: "", result: "", rows: [], selection: "", cancelRequested: false, run: 0 };
      states.set(path, st);
    }
    return st;
  };
  const currentPath = () => host.activePath();
  const found = () => (agents ?? []).filter((a) => a.path !== null);

  /** 수락할 수 있는 상태인가 — 시작 시점 원문과 지금 원문이 같아야 한다. */
  const isStale = (path: string, st: TabState) => host.peek(path) !== st.snapshot;

  function render(): void {
    const path = currentPath();
    const st = path ? stateOf(path) : null;
    const phase = st?.phase ?? "idle";
    const usable = found().length > 0;

    empty.hidden = agents === null || usable;
    logEl.replaceChildren(
      ...(st?.log ?? []).map((line) => {
        const div = document.createElement("div");
        div.textContent = line;
        return div;
      }),
    );
    logEl.scrollTop = logEl.scrollHeight;
    errorEl.hidden = !st?.error;
    errorEl.textContent = st?.error ?? "";

    if (prompt.value !== (st?.prompt ?? "")) prompt.value = st?.prompt ?? "";
    prompt.disabled = phase !== "idle";
    for (const chip of chipsEl.querySelectorAll("button")) chip.disabled = phase !== "idle" || !path;
    const picked = st?.selection ?? "";
    selectionEl.hidden = !picked;
    selectionText.textContent =
      picked.length > MAX_SELECTION_PREVIEW ? `${picked.slice(0, MAX_SELECTION_PREVIEW)}…` : picked;
    btn.send.disabled = phase !== "idle" || !usable || !prompt.value.trim() || !path;
    // 실행 중에도 보내기 단추는 보이되 눌리지 않는다 — 취소가 같은 자리에 더해질 뿐이다.
    btn.cancel.hidden = phase !== "running";
    select.disabled = phase !== "idle";

    review.hidden = phase !== "review";
    if (phase === "review" && st && path) {
      const changed = st.result !== st.snapshot;
      const outdated = isStale(path, st);
      stale.hidden = !outdated;
      nochange.hidden = changed;
      diffEl.hidden = !changed;
      if (changed && diffEl.dataset.run !== String(st.run)) {
        diffEl.dataset.run = String(st.run);
        diffEl.replaceChildren(
          ...st.rows.map((row) => {
            const div = document.createElement("div");
            div.dataset.line = row.kind;
            div.textContent = row.line;
            return div;
          }),
        );
      }
      btn.accept.hidden = !changed;
      btn.accept.disabled = outdated;
      btn.reject.hidden = !changed || outdated;
      btn.discard.hidden = changed && !outdated;
      btn.rerun.hidden = !outdated;
    }
  }

  async function detect(): Promise<void> {
    if (agents !== null || detecting) return;
    detecting = true;
    try {
      agents = await invoke<DetectedAgent[]>("detect_agents");
    } catch {
      agents = [];
    } finally {
      detecting = false;
    }
    showAgents();
  }

  /** 탐색 결과로 프리셋 목록을 다시 만든다. 고른 것이 아직 쓸 수 있으면 그대로 둔다. */
  function showAgents(): void {
    const previous = select.value;
    select.replaceChildren(
      ...(agents ?? []).map((a) => {
        const opt = document.createElement("option");
        opt.value = a.id;
        opt.disabled = a.path === null;
        opt.textContent = a.path === null ? `${a.name} (없음)` : a.name;
        return opt;
      }),
    );
    const keep = found().find((a) => a.id === previous);
    const pick = keep ?? found()[0];
    if (pick) select.value = pick.id;
    render();
  }

  /** 빠른 액션 칩을 저장된 목록으로 다시 만든다. */
  function showChips(): void {
    chipsEl.replaceChildren(
      ...readQuickActions().map((action) => {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.dataset.agentChip = action.name;
        chip.textContent = action.name;
        chip.addEventListener("click", () => {
          const path = currentPath();
          if (!path) return;
          stateOf(path).prompt = action.text;
          render();
          prompt.focus();
        });
        return chip;
      }),
    );
    render();
  }

  async function run(path: string): Promise<void> {
    const st = stateOf(path);
    const text = host.source(path);
    const preset = select.value;
    if (text === null || !preset || !st.prompt.trim()) return;
    // 고른 글자가 있으면 지시 앞에 인용한다. 에이전트가 고른 곳 밖을 고쳐도 막지 않는다 — diff에서 거절하면 된다.
    const instruction = st.selection ? `다음 부분을 대상으로 해 줘:\n<선택>\n${st.selection}\n</선택>\n\n${st.prompt}` : st.prompt;
    const id = ++st.run;
    st.phase = "running";
    st.error = null;
    st.log = [];
    st.snapshot = text;
    st.cancelRequested = false;
    render();
    try {
      const result = await invoke<string>("run_agent", { preset, prompt: instruction, text, path });
      if (states.get(path) !== st || st.run !== id) return;
      st.result = result;
      st.rows = result === text ? [] : lineDiff(text, result);
      st.phase = "review";
    } catch (e) {
      if (states.get(path) !== st || st.run !== id) return;
      st.phase = "idle";
      // 사용자가 취소한 실행이 오류로 끝난 것은 오류가 아니다.
      st.error = st.cancelRequested ? null : String(e);
    }
    if (path === currentPath()) render();
  }

  /** 리뷰를 닫고 처음 상태로 돌아간다. */
  function leaveReview(path: string): void {
    const st = stateOf(path);
    st.phase = "idle";
    st.result = "";
    st.rows = [];
    render();
  }

  async function accept(path: string): Promise<void> {
    const st = stateOf(path);
    // 편집기에 남은 입력까지 밀어낸 원문으로 비교한다.
    if (host.source(path) !== st.snapshot) {
      render();
      return;
    }
    await host.apply(path, st.result);
    // 반영된 결과 뒤에는 고른 글자의 자리가 달라졌을 수 있다.
    st.selection = "";
    leaveReview(path);
  }

  showChips();
  window.addEventListener(QUICK_ACTIONS_EVENT, showChips);
  window.addEventListener("storage", (event) => {
    if (isQuickActionsStorageKey(event.key)) showChips();
  });
  // 설정 창에서 다시 찾기·수동 경로로 결과가 바뀌면 그 결과를 그대로 받는다(다시 묻지 않는다).
  window.addEventListener(AGENTS_CHANGED_EVENT, (event) => {
    agents = (event as CustomEvent<DetectedAgent[]>).detail;
    showAgents();
  });
  $("selection-clear").addEventListener("click", () => {
    const path = currentPath();
    if (path) stateOf(path).selection = "";
    render();
  });
  // 고른 글자는 패널을 누르는 순간 읽는다 — 포커스가 편집기를 떠나면 편집 전용 모드(Muya)의 선택이 사라진다.
  // 이미 패널 안에 포커스가 있으면(지시를 쓰는 중) 편집기에서 읽을 것이 없으니 건드리지 않는다.
  root.addEventListener(
    "pointerdown",
    () => {
      const path = currentPath();
      if (!path || root.contains(document.activeElement)) return;
      const st = stateOf(path);
      if (st.phase !== "idle") return;
      st.selection = host.selection(path);
      render();
    },
    true,
  );
  select.addEventListener("change", render);
  prompt.addEventListener("input", () => {
    const path = currentPath();
    if (path) stateOf(path).prompt = prompt.value;
    render();
  });
  btn.send.addEventListener("click", () => {
    const path = currentPath();
    if (path) void run(path);
  });
  btn.cancel.addEventListener("click", () => {
    const path = currentPath();
    if (!path) return;
    stateOf(path).cancelRequested = true;
    void invoke("cancel_agent", { path });
  });
  btn.accept.addEventListener("click", () => {
    const path = currentPath();
    if (path) void accept(path);
  });
  btn.reject.addEventListener("click", () => {
    const path = currentPath();
    if (path) leaveReview(path);
  });
  btn.discard.addEventListener("click", () => {
    const path = currentPath();
    if (path) leaveReview(path);
  });
  btn.rerun.addEventListener("click", () => {
    const path = currentPath();
    if (!path) return;
    leaveReview(path);
    void run(path);
  });
  $("close").addEventListener("click", onClose);

  void listen<{ path: string; stream: string; line: string }>("agent-log", (event) => {
    const st = states.get(event.payload.path);
    if (!st) return;
    st.log.push(event.payload.line);
    if (st.log.length > MAX_LOG_LINES) st.log.splice(0, st.log.length - MAX_LOG_LINES);
    if (event.payload.path === currentPath()) render();
  });

  // 검토 중에 사용자가 문서를 고치면 수락할 수 없게 바로 알린다.
  window.setInterval(() => {
    if (root.hidden) return;
    const path = currentPath();
    const st = path ? states.get(path) : undefined;
    if (path && st?.phase === "review" && stale.hidden === !isStale(path, st)) render();
  }, 250);

  return {
    show() {
      root.hidden = false;
      void detect();
      render();
    },
    hide() {
      root.hidden = true;
    },
    refresh: render,
    forget(path) {
      const st = states.get(path);
      if (st?.phase === "running") void invoke("cancel_agent", { path });
      states.delete(path);
      if (path === currentPath()) render();
    },
  };
}

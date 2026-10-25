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
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  AGENTS_CHANGED_EVENT,
  QUICK_ACTIONS_EVENT,
  isQuickActionsStorageKey,
  readAutoAccept,
  readQuickActions,
  saveAutoAccept,
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

/** 출력 상자의 한 줄. `kind`는 user · status · thinking · tool · message · warning · error · raw 중 하나다. */
interface Entry {
  kind: string;
  text: string;
  /** 보낸 시각(ms) — 질의 말풍선 아래에 보인다. */
  ts?: number;
}

type Outcome = "ok" | "error" | "cancelled";

/** 탭별 상태. 다른 탭으로 가도 실행은 계속되고, 돌아오면 그대로 보인다. */
interface TabState {
  phase: Phase;
  /** 입력 상자에 쓰고 있는 글. 보내면 비워진다. */
  prompt: string;
  /** 마지막으로 보낸 지시 — 실패·취소하면 입력 상자로 되돌리고, 다시 실행에 쓴다. */
  sent: string;
  log: Entry[];
  /** 실행을 시작한 시각과 끝난 시각(ms). 끝나기 전에는 endedAt이 null이다. */
  startedAt: number;
  endedAt: number | null;
  /** 지금 하는 일 — 상태 줄에 보인다. */
  step: string;
  provider: string;
  /** 이 대화를 이어 온 프로바이더 id — 바뀌면 새 대화다. */
  preset: string;
  outcome: Outcome | null;
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
    <p class="agent-empty" data-agent-empty hidden>사용할 수 있는 프로바이더가 없습니다. 설정의 '프로바이더' 탭에서 켜거나, Claude Code·Codex·OpenCode 중 하나를 설치하고 터미널에서 실행되는지 확인하세요.</p>
    <section class="agent-output">
      <div class="agent-output-head">
        <span class="agent-status" data-agent-status hidden></span>
        <button type="button" class="agent-copy" data-agent-new title="이 대화를 끝내고 새로 시작합니다(이전 질문을 잊습니다)" hidden>새 대화</button>
        <button type="button" class="agent-copy" data-agent-copy title="출력을 클립보드로 복사">복사</button>
      </div>
      <div class="agent-log" data-agent-log role="log" aria-live="polite"></div>
    </section>
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
        <label class="agent-auto" title="결과가 오면 diff 검토 없이 문서에 바로 반영합니다. 저장은 하지 않습니다.">
          <input type="checkbox" data-agent-autoaccept /> 자동 수락
        </label>
        <button type="button" data-agent-send>보내기</button>
        <button type="button" data-agent-cancel>취소</button>
      </div>
    </footer>`;

  const $ = <T extends HTMLElement>(name: string) => root.querySelector<T>(`[data-agent-${name}]`)!;
  const select = $<HTMLSelectElement>("preset");
  const empty = $("empty");
  const logEl = $("log");
  const statusEl = $("status");
  const copyBtn = $<HTMLButtonElement>("copy");
  const newBtn = $<HTMLButtonElement>("new");
  const errorEl = $("error");
  const review = $("review");
  const stale = $("stale");
  const nochange = $("nochange");
  const diffEl = $("diff");
  const prompt = $<HTMLTextAreaElement>("prompt");
  const autoBox = $<HTMLInputElement>("autoaccept");
  autoBox.checked = readAutoAccept();
  autoBox.addEventListener("change", () => saveAutoAccept(autoBox.checked));
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
      st = {
        phase: "idle", prompt: "", sent: "", log: [], startedAt: 0, endedAt: null, step: "", provider: "", preset: "", outcome: null,
        error: null, snapshot: "", result: "", rows: [], selection: "", cancelRequested: false, run: 0,
      };
      states.set(path, st);
    }
    return st;
  };
  const currentPath = () => host.activePath();
  const found = () => (agents ?? []).filter((a) => a.path !== null && a.enabled !== false);

  const mark: Record<string, string> = { status: "·", thinking: "…", tool: "▸", warning: "⚠", error: "✗", message: "", raw: "" };

  const DAYS = ["일", "월", "화", "수", "목", "금", "토"].map((d) => `${d}요일`);
  /** "토요일 오전 12:53" — 로케일 데이터에 기대지 않고 직접 만든다(엔진마다 한국어 데이터가 다를 수 있다). */
  function timeLabel(ts: number): string {
    const d = new Date(ts);
    const h = d.getHours();
    return `${DAYS[d.getDay()]} ${h < 12 ? "오전" : "오후"} ${h % 12 === 0 ? 12 : h % 12}:${String(d.getMinutes()).padStart(2, "0")}`;
  }

  const ICON_COPY =
    '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>';
  const ICON_REDO =
    '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg>';
  const ICON_CHECK =
    '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5 9-10"/></svg>';

  function iconButton(attr: string, label: string, icon: string): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "agent-icon";
    b.setAttribute(attr, "");
    b.title = label;
    b.setAttribute("aria-label", label);
    b.innerHTML = icon;
    return b;
  }

  /** 글을 클립보드로 복사하고 아이콘을 잠깐 체크로 바꿔 알린다. */
  async function copyEntry(button: HTMLButtonElement, value: string): Promise<void> {
    try {
      await writeText(value);
      button.dataset.copied = "true";
      button.innerHTML = ICON_CHECK;
      button.title = "복사됨";
    } catch {
      button.title = "복사하지 못했습니다";
    }
    window.setTimeout(() => {
      delete button.dataset.copied;
      button.innerHTML = ICON_COPY;
      button.title = "복사";
    }, 1500);
  }

  /** 출력 상자의 한 항목을 그리는 요소들. 내가 보낸 질의는 말풍선 + 시각·되돌리기·복사 줄, 에이전트의 답은 복사 아이콘이 붙는다. */
  function entryNodes(entry: Entry): HTMLElement[] {
    const div = document.createElement("div");
    div.dataset.kind = entry.kind;
    if (entry.kind === "user") {
      div.textContent = entry.text;
      const meta = document.createElement("div");
      meta.className = "agent-meta";
      const time = document.createElement("span");
      time.className = "agent-time";
      time.dataset.agentTime = "";
      time.textContent = entry.ts ? timeLabel(entry.ts) : "";
      const redo = iconButton("data-agent-entry-redo", "입력 상자로 되돌리기", ICON_REDO);
      redo.addEventListener("click", () => {
        const path = currentPath();
        if (!path) return;
        stateOf(path).prompt = entry.text;
        render();
        prompt.focus();
      });
      const copy = iconButton("data-agent-entry-copy", "복사", ICON_COPY);
      copy.addEventListener("click", () => void copyEntry(copy, entry.text));
      meta.append(time, redo, copy);
      return [div, meta];
    }
    if (mark[entry.kind]) {
      const m = document.createElement("span");
      m.className = "agent-mark";
      m.textContent = mark[entry.kind];
      div.append(m, " ");
    }
    div.append(entry.text);
    if (entry.kind === "message") {
      const copy = iconButton("data-agent-entry-copy", "복사", ICON_COPY);
      copy.addEventListener("click", () => void copyEntry(copy, entry.text));
      div.append(copy);
    }
    return [div];
  }

  /** 출력 상자에 한 줄을 더한다. 바로 앞 줄과 같으면(설정 경고 반복 등) 더하지 않는다. */
  function pushEntry(path: string, entry: Entry): void {
    const st = stateOf(path);
    const last = st.log[st.log.length - 1];
    if (last && last.kind === entry.kind && last.text === entry.text) return;
    st.log.push(entry);
    const overflow = st.log.length > MAX_LOG_LINES;
    if (overflow) st.log.shift();
    if (entry.kind === "status" || entry.kind === "thinking" || entry.kind === "tool") st.step = entry.text;
    if (path !== currentPath()) return;
    if (overflow) {
      // 가장 오래된 항목이 밀려났다 — 말풍선은 요소가 둘이라 통째로 다시 그린다.
      logEl.replaceChildren(...st.log.flatMap(entryNodes));
    } else {
      logEl.append(...entryNodes(entry));
    }
    logEl.scrollTop = logEl.scrollHeight;
    updateStatus();
    copyBtn.disabled = false;
    newBtn.hidden = false;
  }

  const mmss = (ms: number) => {
    const total = Math.max(0, Math.floor(ms / 1000));
    return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
  };

  /** 상태 줄 — 실행 중이면 누구에게 시킨 일이 얼마나 걸렸고 지금 무엇을 하는지, 끝나면 결과와 걸린 시간. */
  function updateStatus(): void {
    const path = currentPath();
    const st = path ? states.get(path) : undefined;
    if (!st || !st.startedAt) {
      statusEl.hidden = true;
      return;
    }
    const elapsed = mmss((st.endedAt ?? Date.now()) - st.startedAt);
    statusEl.dataset.state = st.phase === "running" ? "running" : (st.outcome ?? "ok");
    statusEl.textContent =
      st.phase === "running"
        ? `● ${st.provider} 실행 중 · ${elapsed} — ${st.step}`
        : st.outcome === "error"
          ? `✗ 실패 · ${elapsed}`
          : st.outcome === "cancelled"
            ? `취소됨 · ${elapsed}`
            : `✓ 완료 · ${elapsed}`;
    statusEl.hidden = false;
  }

  /** 출력 상자의 글을 복사할 문자열로 만든다. */
  const outputText = (st: TabState) => st.log.map((e) => (e.kind === "user" ? `> ${e.text}` : e.text)).join("\n");

  /** 수락할 수 있는 상태인가 — 시작 시점 원문과 지금 원문이 같아야 한다. */
  const isStale = (path: string, st: TabState) => host.peek(path) !== st.snapshot;

  function render(): void {
    const path = currentPath();
    const st = path ? stateOf(path) : null;
    const phase = st?.phase ?? "idle";
    const usable = found().length > 0;

    empty.hidden = agents === null || usable;
    logEl.replaceChildren(...(st?.log ?? []).flatMap(entryNodes));
    logEl.scrollTop = logEl.scrollHeight;
    // 실행 중이거나 결과를 검토하는 중에는 입력 상자를 쓸 수 없으니 되돌리기도 막는다.
    for (const b of logEl.querySelectorAll<HTMLButtonElement>("[data-agent-entry-redo]")) b.disabled = phase !== "idle";
    copyBtn.disabled = !st?.log.length;
    // 대화가 있을 때만 보이고, 실행 중이거나 결과를 검토하는 중에는 끊을 수 없다.
    newBtn.hidden = !st?.log.length;
    newBtn.disabled = phase !== "idle";
    updateStatus();
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
        opt.disabled = a.path === null || a.enabled === false;
        opt.textContent = a.path === null ? `${a.name} (없음)` : a.enabled === false ? `${a.name} (꺼짐)` : a.name;
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

  async function run(path: string, raw: string): Promise<void> {
    const st = stateOf(path);
    const text = host.source(path);
    const preset = select.value;
    if (text === null || !preset || !raw.trim()) return;
    // 고른 글자가 있으면 지시 앞에 인용한다. 에이전트가 고른 곳 밖을 고쳐도 막지 않는다 — diff에서 거절하면 된다.
    const instruction = st.selection ? `다음 부분을 대상으로 해 줘:\n<선택>\n${st.selection}\n</선택>\n\n${raw}` : raw;
    const id = ++st.run;
    st.phase = "running";
    st.error = null;
    st.outcome = null;
    st.snapshot = text;
    st.cancelRequested = false;
    st.sent = raw;
    st.provider = select.selectedOptions[0]?.textContent?.replace(/\s*\(.*\)$/, "") ?? preset;
    st.startedAt = Date.now();
    st.endedAt = null;
    st.step = "요청을 보내는 중";
    // 보낸 지시를 출력 상자 맨 위에 두고, 보내자마자 상태 줄이 돈다 — CLI가 첫 줄을 내기까지 비어 보이지 않게.
    // 출력은 전송마다 지우지 않고 쌓는다 — 같은 탭의 대화는 Rust가 CLI의 세션으로 이어 준다. 프로바이더를 바꾸면 새 대화다.
    if (st.log.length && st.preset && st.preset !== preset) st.log.push({ kind: "status", text: "프로바이더가 바뀌어 새 대화로 시작합니다" });
    st.preset = preset;
    st.log.push({ kind: "user", text: raw, ts: Date.now() });
    if (st.selection) st.log.push({ kind: "status", text: `고른 부분 ${st.selection.length}자를 함께 보냈습니다` });
    st.log.push({ kind: "status", text: `${st.provider}에 요청을 보냈습니다` });
    if (st.log.length > MAX_LOG_LINES) st.log.splice(0, st.log.length - MAX_LOG_LINES);
    render();
    const finish = (outcome: Outcome) => {
      st.endedAt = Date.now();
      st.outcome = outcome;
    };
    try {
      const result = await invoke<string>("run_agent", { preset, prompt: instruction, text, path });
      if (states.get(path) !== st || st.run !== id) return;
      st.result = result;
      st.rows = result === text ? [] : lineDiff(text, result);
      st.phase = "review";
      finish("ok");
      // 자동 수락: 변경이 있고 실행하는 동안 문서가 바뀌지 않았을 때만. 바뀌었으면 검토 화면에서 사람이 고른다.
      if (autoBox.checked && result !== text && (await accept(path))) {
        pushEntry(path, { kind: "status", text: "자동으로 수락해 문서에 반영했습니다 (저장은 직접 하세요)" });
      }
    } catch (e) {
      if (states.get(path) !== st || st.run !== id) return;
      st.phase = "idle";
      // 사용자가 취소한 실행이 오류로 끝난 것은 오류가 아니다.
      st.error = st.cancelRequested ? null : String(e);
      finish(st.cancelRequested ? "cancelled" : "error");
      st.log.push({ kind: st.cancelRequested ? "status" : "error", text: st.cancelRequested ? "취소했습니다" : String(e) });
      // 실패·취소한 지시는 입력 상자로 돌려 고쳐서 다시 보낼 수 있게 한다.
      if (!st.prompt) st.prompt = st.sent;
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

  /** 결과를 문서에 반영한다. 실행하는 동안 문서가 바뀌었으면 반영하지 않고 false. */
  async function accept(path: string): Promise<boolean> {
    const st = stateOf(path);
    // 편집기에 남은 입력까지 밀어낸 원문으로 비교한다.
    if (host.source(path) !== st.snapshot) {
      render();
      return false;
    }
    await host.apply(path, st.result);
    // 반영된 결과 뒤에는 고른 글자의 자리가 달라졌을 수 있다.
    st.selection = "";
    leaveReview(path);
    return true;
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
  // Enter로 보낸다(Shift+Enter는 줄바꿈). 한글 같은 조합 입력 중의 Enter는 글자를 확정하는 키이므로 보내지 않는다.
  prompt.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (!btn.send.disabled) btn.send.click();
  });
  btn.send.addEventListener("click", () => {
    const path = currentPath();
    const raw = prompt.value.trim();
    if (!path || !raw) return;
    // 보낸 지시는 출력 상자 맨 위로 옮겨 가고 입력 상자는 비운다.
    stateOf(path).prompt = "";
    prompt.value = "";
    void run(path, raw);
  });
  newBtn.addEventListener("click", () => {
    const path = currentPath();
    const st = path ? states.get(path) : undefined;
    if (!path || !st || st.phase !== "idle") return;
    // Rust가 이 탭의 대화(임시 폴더와 CLI 세션)를 끝낸다. 화면도 처음 상태로 돌아간다.
    void invoke("reset_agent_session", { path });
    st.log = [];
    st.sent = "";
    st.startedAt = 0;
    st.endedAt = null;
    st.step = "";
    st.preset = "";
    st.outcome = null;
    st.error = null;
    render();
  });
  copyBtn.addEventListener("click", async () => {
    const path = currentPath();
    const st = path ? states.get(path) : undefined;
    if (!st?.log.length) return;
    try {
      await writeText(outputText(st));
      copyBtn.textContent = "복사됨";
    } catch {
      copyBtn.textContent = "복사 실패";
    }
    window.setTimeout(() => (copyBtn.textContent = "복사"), 1500);
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
    const again = stateOf(path).sent;
    leaveReview(path);
    void run(path, again);
  });
  $("close").addEventListener("click", onClose);

  // 진행 단계(`kind`가 있는 줄)와 CLI 원문 줄(`kind`가 없는 줄)을 출력 상자에 차례로 쌓는다.
  void listen<{ path: string; stream: string; kind?: string; line: string }>("agent-log", (event) => {
    const { path, kind, line } = event.payload;
    if (!states.has(path)) return;
    pushEntry(path, { kind: kind ?? "raw", text: line });
  });

  // 검토 중에 사용자가 문서를 고치면 수락할 수 없게 바로 알린다.
  window.setInterval(() => {
    if (root.hidden) return;
    const path = currentPath();
    const st = path ? states.get(path) : undefined;
    if (path && st?.phase === "review" && stale.hidden === !isStale(path, st)) render();
    // 실행 중에는 경과 시간이 흐른다.
    if (st?.phase === "running") updateStatus();
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
      // 탭이 닫히면 이 탭의 대화(임시 폴더)도 정리한다.
      void invoke("reset_agent_session", { path });
      states.delete(path);
      if (path === currentPath()) render();
    },
  };
}

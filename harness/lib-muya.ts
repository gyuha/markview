// Muya 하네스 공용 도우미. 파일 이름이 `muya-`로 시작하지 않아야 run.mjs가 하네스로 돌리지 않는다.
// 편집 동작은 DOM 입력(execCommand·keydown)으로만 일으키고, 엔진 API는 판정(getMarkdown 등)에만 쓴다.
import { EditorView } from "@codemirror/view";
import type { MuyaEditor } from "../src/muya";

export interface HarnessTab {
  path: string;
  mode: "edit" | "split" | "view";
  source: string;
  dirty: boolean;
  pane: HTMLElement;
  button: HTMLElement;
  dirtyDot: HTMLElement;
  editorHost: HTMLElement;
  muyaHost: HTMLElement;
  muya: MuyaEditor | null;
}

interface MockCall {
  cmd: string;
  args?: Record<string, unknown>;
}

const out = document.querySelector<HTMLElement>("#out")!;
const lines: string[] = [];

export const wait = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

/** `PASS  [ID] 설명` / `FAIL  [ID] 설명  got=… want=…` 한 줄. ID 없는 보조 검사는 id를 비운다. */
export function check(id: string, label: string, ok: boolean, detail = ""): void {
  const tag = id ? `[${id}] ` : "";
  lines.push(`${ok ? "PASS" : "FAIL"}  ${tag}${label}${!ok && detail ? `  ${detail}` : ""}`);
}

export function eq(id: string, label: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  check(id, label, ok, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
}

export function note(text: string): void {
  lines.push(text);
}

export function finish(): void {
  lines.push("DONE");
  out.textContent = lines.join("\n");
}

/** 하네스 본문을 돌리고, 중간 예외도 FAIL 줄로 남긴 뒤 반드시 DONE으로 끝낸다(어느 ID가 깨졌는지 보이게). */
export async function guard(body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (error) {
    check("", "하네스 예외", false, String(error));
  }
  finish();
}

export async function waitFor<T>(probe: () => T | null | undefined | false, timeoutMs = 8000): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value) return value;
    await wait(50);
  }
  return null;
}

export function tabs(): HarnessTab[] {
  return (window as unknown as { __MARKVIEW_TABS__?: HarnessTab[] }).__MARKVIEW_TABS__ ?? [];
}

export function activeTab(): HarnessTab | undefined {
  return tabs().find((t) => !t.pane.hidden);
}

export function calls(): MockCall[] {
  return (window as unknown as { __TAURI_MOCK_CALLS__: MockCall[] }).__TAURI_MOCK_CALLS__;
}

/** 표시 여부는 속성이 아니라 computed display로 잰다(하네스 ADR). */
export function visible(el: Element | null | undefined): boolean {
  if (!el) return false;
  for (let node: Element | null = el; node; node = node.parentElement) {
    if (getComputedStyle(node).display === "none") return false;
  }
  return true;
}

export function clickMode(mode: "edit" | "split" | "view"): void {
  document.querySelector<HTMLElement>(`#view-mode [data-mode="${mode}"]`)!.click();
}

export function pressKey(key: string, init: KeyboardEventInit = {}, target?: Element | null): void {
  (target ?? document.activeElement ?? document.body).dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }),
  );
}

/** 탭의 Muya가 만들어질 때까지 기다린다(편집 모드 첫 진입 때 동적으로 불러온다). */
export async function muyaOf(tab: HarnessTab | null | undefined): Promise<MuyaEditor | null> {
  return waitFor(() => tab?.muya ?? null);
}

/** 분할 모드의 CM6 문서를 통째로 바꿔 탭에 픽스처를 넣는다 — 공유 픽스처(DOC.text)를 늘리지 않는다. */
export function injectViaSplit(text: string): void {
  clickMode("split");
  const host = activeTab()!.editorHost;
  const view = EditorView.findFromDOM(host)!;
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
}

export function editorDoc(tab: HarnessTab | undefined): string | null {
  if (!tab) return null;
  return EditorView.findFromDOM(tab.editorHost)?.state.doc.toString() ?? null;
}

/** 블록 내용 요소의 끝에 캐럿을 두고 DOM 입력으로 글자를 넣는다. */
export async function typeAtEnd(content: Element, text: string): Promise<void> {
  const range = document.createRange();
  range.selectNodeContents(content);
  range.collapse(false);
  const selection = getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  await wait(30);
  document.execCommand("insertText", false, text);
  await wait(80);
}

/** 문법 기호(.mu-remove)를 뺀 블록 내용. */
export function contentText(el: Element | null | undefined): string | null {
  if (!el) return null;
  const clone = el.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(".mu-remove").forEach((n) => n.remove());
  return clone.textContent;
}

/** main.ts가 `listen(name)`으로 등록한 콜백을 불러 Tauri 이벤트(메뉴·파일 열기)를 흉내 낸다. */
export function emitTauri(name: string, payload: unknown = null): boolean {
  const call = [...calls()].reverse().find((c) => c.cmd === "plugin:event|listen" && c.args?.event === name);
  const handler = call?.args?.handler as number | undefined;
  const cb = handler === undefined ? undefined : (window as unknown as Record<string, unknown>)[`_cb_${handler}`];
  if (typeof cb !== "function") return false;
  (cb as (e: unknown) => void)({ event: name, id: 0, payload });
  return true;
}

/**
 * 모킹의 invoke를 감싸 특정 명령의 응답을 바꾼다. 기본 모킹은 모든 명령에 null을 돌려준다 —
 * 저장(write_markdown)처럼 응답 형태가 필요한 검사는 여기서 채운다(공유 모킹은 그대로 둔다).
 */
export function respond(cmd: string, reply: (args: Record<string, unknown> | undefined) => unknown): void {
  const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a?: Record<string, unknown>) => Promise<unknown> } })
    .__TAURI_INTERNALS__;
  const original = internals.invoke;
  internals.invoke = async (c, a) => {
    const result = await original(c, a);
    return c === cmd ? reply(a) : result;
  };
}

/** files-opened 이벤트로 새 경로의 탭을 연다(OS 파일 연결과 같은 길). */
export async function openTab(path: string): Promise<HarnessTab | null> {
  let served = false;
  respond("take_pending_files", () => {
    if (served) return [];
    served = true;
    return [path];
  });
  emitTauri("files-opened");
  return waitFor(() => tabs().find((t) => t.path === path));
}

/** 앱이 탭을 다 열 때까지 기다린다. */
export async function ready(): Promise<boolean> {
  return !!(await waitFor(() => document.querySelector(".pane") && tabs().length > 0));
}

/**
 * 블록 안의 글자를 골라 Muya 선택 모델에 알린다. 엔진은 블록의 keyup/click에서 DOM 선택을 읽는다
 * (block/base/format.ts) — Shift+화살표로 고른 것과 같게 선택을 놓고 keyup을 보낸다.
 */
export async function selectText(content: Element, text: string): Promise<boolean> {
  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const at = node.textContent?.indexOf(text) ?? -1;
    if (at < 0) continue;
    const range = document.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + text.length);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
    content.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowRight", shiftKey: true, bubbles: true }));
    await wait(80);
    return true;
  }
  return false;
}

/** 블록 내용 끝에 캐럿을 두고 엔진에 알린다. */
export async function caretAtEnd(content: Element): Promise<void> {
  const range = document.createRange();
  range.selectNodeContents(content);
  range.collapse(false);
  getSelection()!.removeAllRanges();
  getSelection()!.addRange(range);
  content.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowRight", bubbles: true }));
  await wait(80);
}

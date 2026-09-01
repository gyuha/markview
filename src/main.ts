import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
// 값으로 가져온다 — scrollIntoView 이펙트를 쓴다. editor.ts가 이미 번들에 넣으므로 크기 변화는 없다.
import { EditorView } from "@codemirror/view";
import { applyEditorTheme, createEditor } from "./editor";
import { activeHeading, applyFormat, type FormatId } from "./format";
import { confirmDialog } from "./modal";
import { openUrl } from "@tauri-apps/plugin-opener";
import { renderMermaid } from "./mermaid";
import { dirname, isExternalHref, renderInto, resolvePath } from "./render";
import {
  applyChrome,
  applyNativeTheme,
  effectiveOf,
  onSystemChange,
  readChoice,
  saveChoice,
  type Choice,
  type Effective,
} from "./theme";

interface Doc {
  path: string;
  text: string;
  mtime_ms: number;
}

interface SaveOutcome {
  conflict: boolean;
  mtime_ms: number;
}

/** 보기 모드는 탭별 상태다. 편집 전용 · 좌우 분할 · 보기 전용. */
type Mode = "edit" | "split" | "view";

interface Tab {
  path: string;
  /** 좌우 분할 컨테이너. 탭을 감춰도 스크롤 위치와 렌더 결과가 보존된다. */
  pane: HTMLElement;
  /** 스크롤 컨테이너 (프리뷰 쪽). */
  preview: HTMLElement;
  body: HTMLElement;
  button: HTMLElement;
  /** 이 탭의 mermaid를 마지막으로 그린 실효 테마. 현재 테마와 다르면 활성화될 때 다시 그린다. */
  renderedTheme: Effective | null;
  mode: Mode;
  editorHost: HTMLElement;
  /** 편집이 처음 필요할 때 만든다 — 뷰어로만 쓰는 탭은 CM6를 만들지 않는다. */
  editor: EditorView | null;
  /** 현재 원문. 편집하면 갱신된다. */
  source: string;
  previewTimer: number | undefined;
  /** 편집 전용 모드에서 미뤄둔 프리뷰 갱신이 있는지. */
  previewStale: boolean;
  /**
   * 상대편에 밀어 넣은 줄. 그 값으로 돌아오는 scroll 이벤트는 메아리이므로 무시한다.
   * 시간 기반 가드로는 막을 수 없다 — CM6의 scrollIntoView는 measure 단계에서 적용돼
   * 다음 프레임 이후에 스크롤하므로 rAF로 내린 플래그를 통과한다 (하네스가 실측).
   */
  syncEcho: { side: "editor" | "preview"; line: number } | null;
  /** 저장되지 않은 변경이 있는지. */
  dirty: boolean;
  /** 마지막으로 읽거나 저장한 시점의 파일 수정 시각 — 외부 변경 감지에 쓴다. */
  mtimeMs: number;
  dirtyDot: HTMLElement;
}

const tabs: Tab[] = [];
let activePath: string | null = null;
let choice: Choice = "system";
let effective: Effective = "light";
const themeButtons = new Map<Choice, HTMLElement>();
const modeButtons = new Map<Mode, HTMLElement>();
/** 수정자 없는 F키 → 보기 모드. 메뉴에 F키 가속기가 없어 keydown으로 잡힌다. */
const fkeyModes: Record<string, Mode> = { F1: "edit", F2: "split", F3: "view" };
let formatButtons: HTMLButtonElement[] = [];
let menuButtons: HTMLButtonElement[] = [];
let openPop: HTMLElement | null = null;

let tabbarEl: HTMLElement;
let panesEl: HTMLElement;
let emptyEl: HTMLElement;
let noticeEl: HTMLElement;
let noticeTimer: number | undefined;

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

/** 거부 이유처럼 사용자가 알아야 하는 메시지를 잠시 띄운다. */
function notify(message: string): void {
  noticeEl.textContent = message;
  noticeEl.hidden = false;
  window.clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => {
    noticeEl.hidden = true;
  }, 6000);
}

function findTab(path: string): Tab | undefined {
  return tabs.find((t) => t.path === path);
}

function activate(path: string): void {
  activePath = path;
  for (const tab of tabs) {
    const selected = tab.path === path;
    tab.pane.hidden = !selected;
    tab.button.classList.toggle("active", selected);
    tab.button.setAttribute("aria-selected", String(selected));
  }
  emptyEl.hidden = tabs.length > 0;

  syncToolbar();

  // 감춰진 동안 테마가 바뀐 탭은 이 시점에 따라잡는다 (전체 탭을 즉시 재렌더하지 않는 이유).
  const tab = findTab(path);
  if (tab && tab.renderedTheme !== effective) {
    void paintMermaid(tab);
  }
}

function markDirty(tab: Tab, dirty: boolean): void {
  tab.dirty = dirty;
  tab.dirtyDot.hidden = !dirty;
}

/** 활성 탭을 저장한다. 외부에서 파일이 바뀌어 있으면 확인을 받고 덮어쓴다. */
async function saveActive(force = false): Promise<void> {
  if (!activePath) return;
  const tab = findTab(activePath);
  if (!tab || !tab.dirty) return;

  try {
    const outcome = await invoke<SaveOutcome>("write_markdown", {
      path: tab.path,
      text: tab.source,
      expectedMtimeMs: tab.mtimeMs,
      force,
    });
    if (outcome.conflict) {
      const overwrite = await confirmDialog({
        message: `${basename(tab.path)} 파일이 외부에서 변경되었습니다.\n덮어쓰면 그 변경이 사라집니다.`,
        confirmLabel: "덮어쓰기",
      });
      if (overwrite) await saveActive(true);
      return;
    }
    tab.mtimeMs = outcome.mtime_ms;
    markDirty(tab, false);
  } catch (e) {
    notify(String(e));
  }
}

/** 미저장 문서를 잃기 전에 확인을 받는다. 진행해도 되면 true. */
async function confirmDiscard(tab: Tab): Promise<boolean> {
  if (!tab.dirty) return true;
  return confirmDialog({
    message: `${basename(tab.path)}에 저장하지 않은 변경이 있습니다.\n닫으면 사라집니다.`,
    confirmLabel: "저장하지 않고 닫기",
  });
}

/** 모드 라디오 중 활성 탭의 모드만 켜고, 보기 전용이면 서식 버튼을 잠근다. */
function syncToolbar(): void {
  const tab = activePath ? findTab(activePath) : undefined;
  const mode = tab?.mode ?? "view";
  for (const [value, button] of modeButtons) {
    const selected = value === mode;
    button.setAttribute("aria-checked", String(selected));
    button.classList.toggle("active", selected);
  }
  const locked = !tab || mode === "view";
  for (const button of formatButtons) button.disabled = locked;
  for (const button of menuButtons) button.disabled = locked;
  if (locked) closePopover();
}

/** 모드에 따라 에디터와 프리뷰의 표시를 정한다. CM6는 편집이 처음 필요할 때 만든다. */
function applyMode(tab: Tab): void {
  tab.editorHost.hidden = tab.mode === "view";
  tab.preview.hidden = tab.mode === "edit";

  if (tab.mode !== "view" && !tab.editor) {
    tab.editor = createEditor(tab.editorHost, tab.source, effective, (next) => {
      tab.source = next;
      markDirty(tab, true);
      schedulePreview(tab);
    });
    attachEditorScrollSync(tab);
  }
  // 편집 전용에서 미뤄둔 갱신이 있으면 프리뷰가 다시 보이는 지금 따라잡는다.
  if (tab.mode !== "edit" && tab.previewStale) renderPreview(tab);
  if (tab.mode !== "view") tab.editor?.focus();
}

function setMode(tab: Tab, mode: Mode): void {
  tab.mode = mode;
  applyMode(tab);
  syncToolbar();
}

/**
 * 프리뷰 갱신을 250ms 미룬다. 파싱이 프론트엔드에 있어(ADR 260822-220748)
 * 키 입력마다 다시 그리면 메인 스레드가 막힌다.
 */
function schedulePreview(tab: Tab): void {
  window.clearTimeout(tab.previewTimer);
  tab.previewTimer = window.setTimeout(() => {
    // 편집 전용에서는 프리뷰가 감춰져 있다 — 헛일을 피해 미뤄두고 모드가 바뀔 때 따라잡는다.
    if (tab.mode === "edit") {
      tab.previewStale = true;
      return;
    }
    renderPreview(tab);
  }, 250);
}

function renderPreview(tab: Tab): void {
  tab.previewStale = false;
  // innerHTML을 갈아끼우면 내용 높이가 순간 0이 되어 브라우저가 scrollTop을 0으로 클램프한다.
  // 픽셀이 아니라 줄을 기억하는 이유: mermaid가 렌더되며 높이가 바뀌면 픽셀 값은 무의미해진다.
  const line = previewTopLine(tab);
  renderInto(tab.body, tab.source, tab.path);
  if (line !== null) scrollPreviewToLine(tab, line);
  // mermaid SVG가 들어오며 높이가 또 바뀌므로 그 뒤에 한 번 더 맞춘다.
  void paintMermaid(tab).then(() => {
    if (line !== null) scrollPreviewToLine(tab, line);
  });
}

interface Anchor {
  el: HTMLElement;
  line: number;
}

/** 문서 순서(= 위에서 아래) 그대로의 앵커 목록. */
function anchorList(tab: Tab): Anchor[] {
  return [...tab.body.querySelectorAll<HTMLElement>("[data-line]")].map((el) => ({
    el,
    line: Number(el.dataset.line),
  }));
}

/**
 * 뷰포트 y를 프리뷰의 scrollTop 값으로 바꾸는 기준점.
 * offsetTop을 쓰지 않는 이유: `.preview`는 position이 없어 offsetTop이 `.pane` 기준으로 잡힌다.
 */
function previewBase(tab: Tab): number {
  return tab.preview.getBoundingClientRect().top - tab.preview.scrollTop;
}

/** 프리뷰 최상단에 걸린 원문 줄(0-based, 앵커 사이는 보간). */
function previewTopLine(tab: Tab): number | null {
  const anchors = anchorList(tab);
  if (anchors.length === 0) return null;
  const base = previewBase(tab);
  const top = tab.preview.scrollTop;
  let prev = anchors[0];
  for (const a of anchors) {
    const offset = a.el.getBoundingClientRect().top - base;
    if (offset <= top) {
      prev = a;
      continue;
    }
    const prevOffset = prev.el.getBoundingClientRect().top - base;
    const span = offset - prevOffset;
    const frac = span <= 0 ? 0 : (top - prevOffset) / span;
    return prev.line + (a.line - prev.line) * frac;
  }
  return prev.line;
}

/** 원문 줄에 대응하는 프리뷰의 scrollTop. 앵커 사이는 선형 보간한다. */
function previewOffsetForLine(tab: Tab, line: number): number | null {
  const anchors = anchorList(tab);
  if (anchors.length === 0) return null;
  const base = previewBase(tab);
  let prev = anchors[0];
  for (const a of anchors) {
    if (a.line <= line) {
      prev = a;
      continue;
    }
    const prevTop = prev.el.getBoundingClientRect().top - base;
    const nextTop = a.el.getBoundingClientRect().top - base;
    const span = a.line - prev.line;
    const frac = span === 0 ? 0 : (line - prev.line) / span;
    return prevTop + (nextTop - prevTop) * frac;
  }
  return prev.el.getBoundingClientRect().top - base;
}

function scrollPreviewToLine(tab: Tab, line: number): void {
  const offset = previewOffsetForLine(tab, line);
  if (offset === null) return;
  tab.preview.scrollTop = offset;
}

/** 에디터 최상단에 걸린 줄(0-based — data-line과 같은 기준). */
function editorTopLine(tab: Tab): number | null {
  const view = tab.editor;
  if (!view) return null;
  // lineBlockAtHeight는 문서 top 기준 높이를 받는다. documentTop은 화면 좌표계다.
  const height = view.scrollDOM.getBoundingClientRect().top - view.documentTop;
  const block = view.lineBlockAtHeight(height);
  return view.state.doc.lineAt(block.from).number - 1;
}

function scrollEditorToLine(tab: Tab, line: number): void {
  const view = tab.editor;
  if (!view) return;
  const n = Math.min(Math.max(Math.round(line) + 1, 1), view.state.doc.lines);
  view.dispatch({
    effects: EditorView.scrollIntoView(view.state.doc.line(n).from, { y: "start" }),
  });
}

/**
 * 방금 이 쪽에 밀어 넣은 값으로 돌아온 scroll 이벤트인지. 맞으면 메아리이므로 되밀지 않는다.
 * 같은 쪽 이벤트가 오면 기대값은 어긋나든 맞든 소진한다 — 메아리가 오지 않는 경우
 * (이미 그 위치여서 스크롤이 없었던 경우) 기대값이 남아 다음 스크롤을 삼키지 않도록.
 */
function isSyncEcho(tab: Tab, side: "editor" | "preview", line: number): boolean {
  const echo = tab.syncEcho;
  if (!echo || echo.side !== side) return false;
  tab.syncEcho = null;
  return Math.abs(echo.line - line) <= 1.5;
}

/** 프리뷰 쪽 리스너. 에디터 쪽은 CM6가 만들어진 뒤에 붙는다(attachEditorScrollSync). */
function installScrollSync(tab: Tab): void {
  tab.preview.addEventListener("scroll", () => {
    if (tab.mode !== "split") return;
    const line = previewTopLine(tab);
    if (line === null || isSyncEcho(tab, "preview", line)) return;
    tab.syncEcho = { side: "editor", line };
    scrollEditorToLine(tab, line);
  });
}

function attachEditorScrollSync(tab: Tab): void {
  tab.editor?.scrollDOM.addEventListener("scroll", () => {
    if (tab.mode !== "split") return;
    const line = editorTopLine(tab);
    if (line === null || isSyncEcho(tab, "editor", line)) return;
    tab.syncEcho = { side: "preview", line };
    scrollPreviewToLine(tab, line);
  });
}

async function paintMermaid(tab: Tab): Promise<void> {
  tab.renderedTheme = effective;
  await renderMermaid(tab.body, effective);
}

/**
 * 실효 테마를 다시 계산해 크롬에 적용하고, 활성 탭의 다이어그램만 즉시 다시 그린다.
 * 순서가 정확성의 일부다: 네이티브 강제를 먼저 풀어야 matchMedia가 진짜 OS 값을 보고한다.
 */
async function applyTheme(): Promise<void> {
  await applyNativeTheme(choice);
  effective = effectiveOf(choice);
  applyChrome(effective);
  // 다섯 번째 겹: 열려 있는 모든 에디터. CM6는 문서를 유지한 채 테마만 교체된다.
  for (const tab of tabs) {
    if (tab.editor) applyEditorTheme(tab.editor, effective);
  }
  const active = activePath ? findTab(activePath) : undefined;
  if (active) void paintMermaid(active);
}

/** 닫기 요청 — 미저장이면 확인을 받고, 승인되면 실제로 닫는다. */
async function requestCloseTab(path: string): Promise<void> {
  const tab = findTab(path);
  if (!tab) return;
  if (!(await confirmDiscard(tab))) return;
  closeTab(path);
}

function closeTab(path: string): void {
  const index = tabs.findIndex((t) => t.path === path);
  if (index < 0) return;
  // 마지막 문서를 닫으면 빈 화면을 남기지 않고 창을 닫는다 (Safari·Chrome과 같은 동작).
  if (tabs.length === 1) {
    void getCurrentWindow().close();
    return;
  }
  const [tab] = tabs.splice(index, 1);
  window.clearTimeout(tab.previewTimer);
  tab.editor?.destroy();
  tab.pane.remove();
  tab.button.remove();
  if (activePath !== path) return;
  const next = tabs[index] ?? tabs[index - 1];
  if (next) {
    activate(next.path);
  } else {
    activePath = null;
    emptyEl.hidden = false;
  }
}

function createTabButton(path: string): HTMLElement {
  const button = document.createElement("div");
  button.className = "tab";
  button.setAttribute("role", "tab");
  button.title = path;

  const label = document.createElement("span");
  label.className = "tab-label";
  label.textContent = basename(path);
  button.appendChild(label);

  const dot = document.createElement("span");
  dot.className = "tab-dirty";
  dot.hidden = true;
  dot.dataset.role = "dirty";
  button.appendChild(dot);

  const close = document.createElement("button");
  close.className = "tab-close";
  close.type = "button";
  close.textContent = "×";
  close.setAttribute("aria-label", `${basename(path)} 닫기`);
  close.addEventListener("click", (event) => {
    event.stopPropagation();
    void requestCloseTab(path);
  });
  button.appendChild(close);

  button.addEventListener("click", () => activate(path));
  // 가운데 버튼. × 버튼의 click 핸들러는 button 0만 받으므로 충돌하지 않는다.
  button.addEventListener("auxclick", (event) => {
    if (event.button !== 1) return;
    event.preventDefault();
    void requestCloseTab(path);
  });
  return button;
}

/** 같은 경로가 이미 열려 있으면 새 탭을 만들지 않고 그 탭을 활성화한다. */
async function openPath(path: string): Promise<void> {
  const existing = findTab(path);
  if (existing) {
    activate(existing.path);
    return;
  }

  let doc: Doc;
  try {
    doc = await invoke<Doc>("read_markdown", { path });
  } catch (e) {
    notify(String(e));
    return;
  }

  if (findTab(doc.path)) {
    activate(doc.path);
    return;
  }

  const pane = document.createElement("div");
  pane.className = "pane";

  const editorHost = document.createElement("div");
  editorHost.className = "editor-host";
  editorHost.hidden = true;
  pane.appendChild(editorHost);

  const preview = document.createElement("div");
  preview.className = "preview";
  const body = document.createElement("article");
  body.className = "markdown-body";
  preview.appendChild(body);
  pane.appendChild(preview);

  renderInto(body, doc.text, doc.path);
  panesEl.appendChild(pane);

  const button = createTabButton(doc.path);
  tabbarEl.appendChild(button);

  const tab: Tab = {
    path: doc.path,
    pane,
    preview,
    body,
    button,
    renderedTheme: null,
    mode: "view",
    editorHost,
    editor: null,
    source: doc.text,
    previewTimer: undefined,
    previewStale: false,
    syncEcho: null,
    dirty: false,
    mtimeMs: doc.mtime_ms,
    dirtyDot: button.querySelector<HTMLElement>('[data-role="dirty"]')!,
  };
  tabs.push(tab);
  installScrollSync(tab);
  activate(doc.path);
  await paintMermaid(tab);
}

/** 파일을 다시 읽어 재렌더하고 보고 있던 위치로 되돌린다. */
async function reloadActive(): Promise<void> {
  if (!activePath) return;
  const tab = findTab(activePath);
  if (!tab) return;

  const scroll = tab.preview.scrollTop;
  try {
    const doc = await invoke<Doc>("read_markdown", { path: tab.path });
    tab.source = doc.text;
    renderInto(tab.body, doc.text, doc.path);
    await paintMermaid(tab);
    tab.preview.scrollTop = scroll;
  } catch (e) {
    notify(String(e));
  }
}

/** 세그먼트 컨트롤을 배선한다. 선택 테마를 고르는 컨트롤이며 실효 테마는 applyTheme가 유도한다. */
function installThemeControl(): void {
  for (const button of document.querySelectorAll<HTMLElement>("#theme [data-choice]")) {
    const value = button.dataset.choice as Choice;
    themeButtons.set(value, button);
    button.addEventListener("click", () => {
      if (choice === value) return;
      choice = value;
      saveChoice(choice);
      syncThemeControl();
      void applyTheme();
    });
  }

  choice = readChoice();
  syncThemeControl();
  void applyTheme();
}

/** 보기 모드 세그먼트를 배선한다. 모드는 탭별이므로 활성 탭에만 적용된다. */
function installViewModeControl(): void {
  for (const button of document.querySelectorAll<HTMLElement>("#view-mode [data-mode]")) {
    const value = button.dataset.mode as Mode;
    modeButtons.set(value, button);
    button.addEventListener("click", () => {
      const tab = activePath ? findTab(activePath) : undefined;
      if (tab && tab.mode !== value) setMode(tab, value);
    });
  }
}

function activeEditor(): EditorView | null {
  return (activePath ? findTab(activePath)?.editor : null) ?? null;
}

function closePopover(): void {
  if (!openPop) return;
  openPop.hidden = true;
  document
    .querySelector(`[data-popover="${openPop.dataset.popoverFor}"]`)
    ?.setAttribute("aria-expanded", "false");
  openPop = null;
  // 팝오버가 닫히면 커서를 편집기로 돌려준다 — 안 그러면 다음 타이핑이 사라진다.
  activeEditor()?.focus();
}

/** 헤딩 팝오버는 열릴 때 커서가 있는 줄의 레벨을 선택 상태로 보여준다. */
function syncHeadingItems(pop: HTMLElement): void {
  const editor = activeEditor();
  const level = editor ? activeHeading(editor.state) : 0;
  for (const item of pop.querySelectorAll<HTMLElement>("[data-format]")) {
    const value = Number(item.dataset.format!.slice(1));
    item.setAttribute("aria-checked", String(value === level));
  }
}

/**
 * 드롭다운을 배선한다. 네이티브 select가 아이콘 툴바와 어울리지 않아 직접 만들었으므로
 * 바깥 클릭·Esc·화살표 이동·포커스 복귀를 전부 여기서 책임진다.
 */
function installPopovers(): void {
  menuButtons = [...document.querySelectorAll<HTMLButtonElement>("#format [data-popover]")];
  for (const trigger of menuButtons) {
    const pop = document.querySelector<HTMLElement>(
      `.popover[data-popover-for="${trigger.dataset.popover}"]`,
    )!;
    trigger.addEventListener("mousedown", (event) => event.preventDefault());
    trigger.addEventListener("click", () => {
      if (openPop === pop) {
        closePopover();
        return;
      }
      closePopover();
      if (trigger.dataset.popover === "heading") syncHeadingItems(pop);
      pop.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
      openPop = pop;
      pop.querySelector<HTMLElement>("[data-format]")?.focus();
    });

    pop.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closePopover();
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const items = [...pop.querySelectorAll<HTMLElement>("[data-format]")];
      const at = items.indexOf(document.activeElement as HTMLElement);
      const step = event.key === "ArrowDown" ? 1 : -1;
      items[(at + step + items.length) % items.length]?.focus();
    });
  }

  // 바깥 클릭으로 닫는다. 트리거 자신의 클릭은 위 토글이 처리하므로 여기서 제외한다.
  document.addEventListener("click", (event) => {
    if (!openPop) return;
    const target = event.target as HTMLElement;
    if (openPop.contains(target) || target.closest("[data-popover]")) return;
    closePopover();
  });
}

/** 서식 버튼을 배선한다. 변환 자체는 format.ts가 상태만 보고 계산한다. */
function installFormatControl(): void {
  formatButtons = [...document.querySelectorAll<HTMLButtonElement>("#format [data-format]")];
  for (const button of formatButtons) {
    const id = button.dataset.format as FormatId;
    // 눌러도 편집기가 포커스를 잃지 않아야 선택 영역이 살아 있다.
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => {
      const editor = activePath ? findTab(activePath)?.editor : undefined;
      if (!editor) return;
      editor.dispatch(applyFormat(editor.state, id));
      closePopover();
      editor.focus();
    });
  }
}

/** 세 버튼 중 현재 선택 하나만 켜진 상태로 맞춘다. */
function syncThemeControl(): void {
  for (const [value, button] of themeButtons) {
    const selected = value === choice;
    button.setAttribute("aria-checked", String(selected));
    button.classList.toggle("active", selected);
  }
}

/**
 * 링크 클릭을 전부 가로챈다. 그냥 두면 webview가 그 주소로 네비게이션해서
 * 앱이 브라우저로 변하고 돌아올 방법이 없다.
 */
function installLinkHandler(): void {
  panesEl.addEventListener("click", (event) => {
    const anchor = (event.target as HTMLElement | null)?.closest("a");
    if (!anchor) return;

    const href = anchor.getAttribute("href");
    event.preventDefault();
    if (!href) return;

    if (href.startsWith("#")) {
      // 탭이 여러 개면 감춰진 탭에도 같은 id가 있을 수 있으므로 활성 페인 안에서만 찾는다.
      const scope = activePath ? findTab(activePath)?.body : undefined;
      const raw = href.slice(1);
      const target = findById(scope ?? document, [
        raw,
        safeDecode(raw),
        encodeURIComponent(raw),
      ]);
      target?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }

    if (isExternalHref(href)) {
      void openUrl(href);
      return;
    }

    if (activePath) {
      void openPath(resolvePath(dirname(activePath), safeDecode(href)));
    }
  });
}

function findById(scope: ParentNode, candidates: string[]): HTMLElement | null {
  for (const id of candidates) {
    const found = scope.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`);
    if (found) return found;
  }
  return null;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

window.addEventListener("DOMContentLoaded", async () => {
  tabbarEl = document.querySelector<HTMLElement>("#tabbar")!;
  panesEl = document.querySelector<HTMLElement>("#panes")!;
  emptyEl = document.querySelector<HTMLElement>("#empty")!;
  noticeEl = document.querySelector<HTMLElement>("#notice")!;
  installViewModeControl();
  installFormatControl();
  installPopovers();
  syncToolbar();
  installThemeControl();

  // 사용자 토글과 OS 변경이 같은 진입점으로 들어온다 — 한쪽만 mermaid 재렌더를 잊는 일이 없도록.
  onSystemChange(() => {
    if (choice === "system") void applyTheme();
  });

  installLinkHandler();

  window.addEventListener("keydown", (event) => {
    // 모달이 떠 있으면 전역 단축키를 통째로 막는다 — confirmDialog은 Esc/Enter 외의 키를
    // 통과시키므로, 막지 않으면 모드 전환의 editor.focus()가 모달의 포커스를 훔친다.
    if (document.querySelector(".modal-backdrop")) return;
    // 수정자 없는 F1~F3은 보기 모드로 직행한다. macOS 내장 키보드에서는 시스템이
    // 밝기·Mission Control로 먼저 먹으므로 fn을 함께 눌러야 한다 — 코드로는 못 고친다.
    const fkeyMode = fkeyModes[event.key];
    if (fkeyMode && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
      event.preventDefault();
      const tab = activePath ? findTab(activePath) : undefined;
      if (tab && tab.mode !== fkeyMode) setMode(tab, fkeyMode);
      return;
    }
    if (!(event.metaKey || event.ctrlKey)) return;
    const key = event.key.toLowerCase();
    if (key === "r") {
      event.preventDefault();
      void reloadActive();
      return;
    }
    // ⌘E는 기본 메뉴에 없으므로 여기서 잡힌다 (⌘W와 달리 메뉴 재조립이 불필요).
    // 가장 흔한 왕복인 분할 ↔ 보기 전용을 토글한다 — 편집 전용은 툴바로만 간다.
    if (key === "e") {
      event.preventDefault();
      const tab = activePath ? findTab(activePath) : undefined;
      if (tab) setMode(tab, tab.mode === "view" ? "split" : "view");
    }
  });

  await getCurrentWebview().onDragDropEvent(async (event) => {
    if (event.payload.type !== "drop") return;
    for (const path of event.payload.paths) {
      await openPath(path);
    }
  });

  // OS 파일 연결로 넘어온 경로. Rust 버퍼가 단일 출처이므로 시작 시 한 번 비우고,
  // 실행 중에 새로 열리면 알림을 받아 다시 비운다 — 비우는 방식이라 중복 열기가 없다.
  await listen("files-opened", () => void drainPendingFiles());
  await drainPendingFiles();

  // ⌘W는 메뉴를 거쳐 온다(가속기가 메뉴에 묶여 있어 keydown으로는 오지 않는다).
  await listen("close-tab", () => {
    // 탭이 하나 남았을 때 창을 닫는 판단은 closeTab 안에 있다 — 가운데 클릭도 같은 경로를 탄다.
    if (activePath) {
      void requestCloseTab(activePath);
      return;
    }
    void getCurrentWindow().close();
  });
  // ⌘S는 메뉴 가속기다 — macOS는 메뉴 키 등가물을 webview보다 먼저 처리하므로
  // keydown으로 잡으려 해도 오지 않는다(⌘W와 같은 이유).
  await listen("save", () => void saveActive());
  await listen("close-window", () => void requestCloseWindow());

  // Rust가 창 닫기를 막고 넘긴 요청 — 미저장 문서가 있으면 확인을 받는다.
  await listen("close-requested", () => void requestCloseWindow());
});

/** 창을 닫아도 되는지 확인한 뒤 닫는다. 미저장 탭이 여러 개면 한 번만 묻는다. */
async function requestCloseWindow(): Promise<void> {
  const dirty = tabs.filter((t) => t.dirty);
  if (dirty.length > 0) {
    const names = dirty.map((t) => basename(t.path)).join(", ");
    const discard = await confirmDialog({
      message: `저장하지 않은 변경이 있습니다: ${names}\n창을 닫으면 사라집니다.`,
      confirmLabel: "저장하지 않고 닫기",
    });
    if (!discard) return;
  }
  for (const tab of tabs) markDirty(tab, false);
  // Rust가 다음 닫기 요청 한 번을 통과시키도록 알린다 — 그러지 않으면 다시 막힌다.
  await invoke("allow_close");
  await getCurrentWindow().close();
}

async function drainPendingFiles(): Promise<void> {
  const paths = await invoke<string[]>("take_pending_files");
  for (const path of paths) {
    await openPath(path);
  }
}

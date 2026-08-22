import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { renderMermaid } from "./mermaid";
import { dirname, isExternalHref, renderInto, resolvePath } from "./render";
import {
  applyChrome,
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
}

interface Tab {
  path: string;
  /** 스크롤 컨테이너. 탭을 감출 때도 유지되므로 스크롤 위치와 렌더 결과가 보존된다. */
  pane: HTMLElement;
  body: HTMLElement;
  button: HTMLElement;
  /** 이 탭의 mermaid를 마지막으로 그린 실효 테마. 현재 테마와 다르면 활성화될 때 다시 그린다. */
  renderedTheme: Effective | null;
}

const tabs: Tab[] = [];
let activePath: string | null = null;
let choice: Choice = "system";
let effective: Effective = "light";
const themeButtons = new Map<Choice, HTMLElement>();

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

  // 감춰진 동안 테마가 바뀐 탭은 이 시점에 따라잡는다 (전체 탭을 즉시 재렌더하지 않는 이유).
  const tab = findTab(path);
  if (tab && tab.renderedTheme !== effective) {
    void paintMermaid(tab);
  }
}

async function paintMermaid(tab: Tab): Promise<void> {
  tab.renderedTheme = effective;
  await renderMermaid(tab.body, effective);
}

/** 실효 테마를 다시 계산해 크롬에 적용하고, 활성 탭의 다이어그램만 즉시 다시 그린다. */
function applyTheme(): void {
  effective = effectiveOf(choice);
  applyChrome(effective);
  const active = activePath ? findTab(activePath) : undefined;
  if (active) void paintMermaid(active);
}

function closeTab(path: string): void {
  const index = tabs.findIndex((t) => t.path === path);
  if (index < 0) return;
  const [tab] = tabs.splice(index, 1);
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

  const close = document.createElement("button");
  close.className = "tab-close";
  close.type = "button";
  close.textContent = "×";
  close.setAttribute("aria-label", `${basename(path)} 닫기`);
  close.addEventListener("click", (event) => {
    event.stopPropagation();
    closeTab(path);
  });
  button.appendChild(close);

  button.addEventListener("click", () => activate(path));
  // 가운데 버튼. × 버튼의 click 핸들러는 button 0만 받으므로 충돌하지 않는다.
  button.addEventListener("auxclick", (event) => {
    if (event.button !== 1) return;
    event.preventDefault();
    closeTab(path);
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
  const body = document.createElement("article");
  body.className = "markdown-body";
  pane.appendChild(body);
  renderInto(body, doc.text, doc.path);
  panesEl.appendChild(pane);

  const button = createTabButton(doc.path);
  tabbarEl.appendChild(button);

  const tab: Tab = { path: doc.path, pane, body, button, renderedTheme: null };
  tabs.push(tab);
  activate(doc.path);
  await paintMermaid(tab);
}

/** 파일을 다시 읽어 재렌더하고 보고 있던 위치로 되돌린다. */
async function reloadActive(): Promise<void> {
  if (!activePath) return;
  const tab = findTab(activePath);
  if (!tab) return;

  const scroll = tab.pane.scrollTop;
  try {
    const doc = await invoke<Doc>("read_markdown", { path: tab.path });
    renderInto(tab.body, doc.text, doc.path);
    await paintMermaid(tab);
    tab.pane.scrollTop = scroll;
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
      applyTheme();
    });
  }

  choice = readChoice();
  syncThemeControl();
  applyTheme();
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
  installThemeControl();

  // 사용자 토글과 OS 변경이 같은 진입점으로 들어온다 — 한쪽만 mermaid 재렌더를 잊는 일이 없도록.
  onSystemChange(() => {
    if (choice === "system") applyTheme();
  });

  installLinkHandler();

  window.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "r") {
      event.preventDefault();
      void reloadActive();
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
    if (activePath) {
      closeTab(activePath);
      return;
    }
    // 닫을 탭이 없으면 창을 닫는다 — 메뉴는 탭 개수를 모르므로 판단이 여기 있다.
    void getCurrentWindow().close();
  });
  await listen("close-window", () => void getCurrentWindow().close());
});

async function drainPendingFiles(): Promise<void> {
  const paths = await invoke<string[]>("take_pending_files");
  for (const path of paths) {
    await openPath(path);
  }
}

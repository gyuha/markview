/**
 * 설정 대화상자 — 모드(라이트/다크/시스템)와 라이트용·다크용 색상 테마를 고른다.
 * modal.ts처럼 자체 HTML로 만든다(의존성을 늘리지 않고 테마 변수를 그대로 따르려는 것이다).
 * 색상 테마 목록은 네이티브 `<select>`가 색 견본을 못 그려서 listbox를 직접 만든다.
 */
import { deriveColors } from "./themeColors";
import { COLOR_THEMES, type ColorTheme, type ThemeKind } from "./themes.generated";
import { readColorTheme, saveColorTheme, type Choice } from "./theme";
import { readRestoreSession, saveRestoreSession } from "./session";

export interface SettingsHost {
  getChoice(): Choice;
  setChoice(choice: Choice): void;
  /** 색상 테마가 저장된 뒤 불린다 — 화면에 다시 칠한다. */
  onColorThemeChange(): void;
}

const MODES: { value: Choice; label: string }[] = [
  { value: "light", label: "라이트" },
  { value: "dark", label: "다크" },
  { value: "system", label: "시스템" },
];

const byName = (a: ColorTheme, b: ColorTheme) => a.name.localeCompare(b.name);
const themesOf = (kind: ThemeKind) => COLOR_THEMES.filter((t) => t.kind === kind).sort(byName);
const themeById = (id: string) => COLOR_THEMES.find((t) => t.id === id)!;

let opened = false;

function swatch(t: ColorTheme): HTMLElement {
  const el = document.createElement("span");
  el.className = "cs-swatch";
  el.setAttribute("aria-hidden", "true");
  for (const color of [t.background, t.normal.blue, t.normal.red, t.normal.green]) {
    const chip = document.createElement("i");
    chip.style.background = color;
    el.appendChild(chip);
  }
  return el;
}

/** 미리보기 칸. 그 색상 테마의 변수를 이 요소에만 걸어 실제 화면에는 영향을 주지 않는다. */
function paintPreview(el: HTMLElement, t: ColorTheme): void {
  el.replaceChildren();
  for (const [name, value] of Object.entries(deriveColors(t).vars)) el.style.setProperty(name, value);
  const title = document.createElement("div");
  title.className = "sp-title";
  title.textContent = t.name;
  const body = document.createElement("p");
  body.className = "sp-body";
  const link = document.createElement("span");
  link.className = "sp-link";
  link.textContent = "링크";
  const code = document.createElement("code");
  code.textContent = "inline";
  body.append("본문 글자와 ", link, " 그리고 ", code);
  const pre = document.createElement("pre");
  pre.className = "sp-code";
  const tokens: [string, string][] = [
    ["sp-k", "const"],
    ["", " answer = "],
    ["sp-n", "42"],
    ["", ";\n"],
    ["sp-f", "greet"],
    ["", "("],
    ["sp-s", '"hello"'],
    ["", ");  "],
    ["sp-c", "// comment"],
  ];
  for (const [cls, text] of tokens) {
    const span = document.createElement("span");
    if (cls) span.className = cls;
    span.textContent = text;
    pre.appendChild(span);
  }
  el.append(title, body, pre);
}

interface ColorSelect {
  row: HTMLElement;
  isOpen(): boolean;
  close(): void;
}

function colorSelect(
  kind: ThemeKind,
  label: string,
  onPick: () => void,
  onPreview: (t: ColorTheme) => void,
): ColorSelect {
  const row = document.createElement("div");
  row.className = "cs-row";
  row.dataset.colorKind = kind;

  const caption = document.createElement("span");
  caption.className = "cs-label";
  caption.textContent = label;

  const box = document.createElement("div");
  box.className = "cs";

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "cs-trigger";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-label", label);

  let list: HTMLElement | null = null;

  const showCurrent = () => {
    const current = themeById(readColorTheme(kind));
    const name = document.createElement("span");
    name.className = "cs-name";
    name.textContent = current.name;
    const caret = document.createElement("span");
    caret.className = "cs-caret";
    caret.textContent = "▾";
    trigger.replaceChildren(swatch(current), name, caret);
  };

  const close = (refocus = false) => {
    if (!list) return;
    list.remove();
    list = null;
    trigger.setAttribute("aria-expanded", "false");
    onPreview(themeById(readColorTheme(kind)));
    if (refocus) trigger.focus();
  };

  const pick = (id: string) => {
    saveColorTheme(kind, id);
    showCurrent();
    close(true);
    onPick();
  };

  const open = () => {
    if (list) return;
    const current = readColorTheme(kind);
    const ul = document.createElement("ul");
    ul.className = "cs-list";
    ul.setAttribute("role", "listbox");
    ul.setAttribute("aria-label", label);
    for (const t of themesOf(kind)) {
      const li = document.createElement("li");
      li.className = "cs-option";
      li.setAttribute("role", "option");
      li.tabIndex = -1;
      li.dataset.id = t.id;
      li.setAttribute("aria-selected", String(t.id === current));
      const name = document.createElement("span");
      name.textContent = t.name;
      li.append(swatch(t), name);
      li.addEventListener("mouseenter", () => onPreview(t));
      li.addEventListener("focus", () => onPreview(t));
      li.addEventListener("click", () => pick(t.id));
      ul.appendChild(li);
    }
    ul.addEventListener("keydown", (event) => {
      const items = [...ul.querySelectorAll<HTMLElement>("[role=option]")];
      const at = items.indexOf(document.activeElement as HTMLElement);
      const move = (to: number) => {
        event.preventDefault();
        items[Math.max(0, Math.min(items.length - 1, to))].focus();
      };
      if (event.key === "ArrowDown") move(at + 1);
      else if (event.key === "ArrowUp") move(at - 1);
      else if (event.key === "Home") move(0);
      else if (event.key === "End") move(items.length - 1);
      else if ((event.key === "Enter" || event.key === " ") && at >= 0) {
        event.preventDefault();
        pick(items[at].dataset.id!);
      } else if (event.key === "Tab") close();
    });
    list = ul;
    box.appendChild(ul);
    trigger.setAttribute("aria-expanded", "true");
    const selected = ul.querySelector<HTMLElement>("[aria-selected=true]");
    (selected ?? ul.firstElementChild)?.scrollIntoView?.({ block: "nearest" });
    (selected ?? (ul.firstElementChild as HTMLElement | null))?.focus();
  };

  trigger.addEventListener("click", () => (list ? close() : open()));
  trigger.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      open();
    }
  });

  showCurrent();
  box.appendChild(trigger);
  row.append(caption, box);
  return { row, isOpen: () => list !== null, close: () => close(true) };
}

export function openSettings(host: SettingsHost): void {
  if (opened) return;
  opened = true;
  const opener = document.activeElement as HTMLElement | null;

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";

  const box = document.createElement("div");
  box.className = "modal settings";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-label", "설정");

  const heading = document.createElement("h2");
  heading.className = "settings-title";
  heading.textContent = "설정";

  // --- 모드 ---
  const modeSection = document.createElement("section");
  const modeLabel = document.createElement("h3");
  modeLabel.className = "settings-heading";
  modeLabel.textContent = "모드";
  const modes = document.createElement("div");
  modes.className = "settings-modes";
  modes.setAttribute("role", "radiogroup");
  modes.setAttribute("aria-label", "모드");
  const modeButtons = new Map<Choice, HTMLElement>();
  const syncModes = () => {
    for (const [value, button] of modeButtons) {
      const on = value === host.getChoice();
      button.setAttribute("aria-checked", String(on));
      button.classList.toggle("active", on);
    }
  };
  for (const { value, label } of MODES) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "settings-mode";
    button.setAttribute("role", "radio");
    button.dataset.modeChoice = value;
    button.textContent = label;
    button.addEventListener("click", () => {
      host.setChoice(value);
      syncModes();
    });
    modeButtons.set(value, button);
    modes.appendChild(button);
  }
  modeSection.append(modeLabel, modes);

  // --- 색상 테마 ---
  const colorSection = document.createElement("section");
  const colorLabel = document.createElement("h3");
  colorLabel.className = "settings-heading";
  colorLabel.textContent = "색상 테마";
  const preview = document.createElement("div");
  preview.className = "settings-preview";
  const showCurrentPreview = (t: ColorTheme) => paintPreview(preview, t);

  const selects = [
    colorSelect("light", "라이트일 때", () => host.onColorThemeChange(), showCurrentPreview),
    colorSelect("dark", "다크일 때", () => host.onColorThemeChange(), showCurrentPreview),
  ];
  const effectiveKind: ThemeKind = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  showCurrentPreview(themeById(readColorTheme(effectiveKind)));
  colorSection.append(colorLabel, ...selects.map((s) => s.row), preview);

  const actions = document.createElement("div");
  actions.className = "modal-actions";
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "settings-close";
  closeButton.textContent = "닫기";
  actions.appendChild(closeButton);

  // --- 환경: 시작 시 지난 세션 복원 ---
  const restoreSection = document.createElement("section");
  const restoreRow = document.createElement("div");
  restoreRow.className = "settings-switch-row";
  const restoreText = document.createElement("div");
  const restoreLabel = document.createElement("div");
  restoreLabel.className = "settings-switch-label";
  restoreLabel.textContent = "시작 시 지난 세션 복원";
  const restoreHint = document.createElement("div");
  restoreHint.className = "settings-switch-hint";
  restoreHint.textContent = "파일을 지정하지 않고 앱을 켜면 마지막에 열려 있던 탭을 그대로 엽니다.";
  restoreText.append(restoreLabel, restoreHint);
  const restoreSwitch = document.createElement("button");
  restoreSwitch.type = "button";
  restoreSwitch.className = "settings-switch";
  restoreSwitch.setAttribute("role", "switch");
  restoreSwitch.setAttribute("aria-label", "시작 시 지난 세션 복원");
  const syncRestore = () => restoreSwitch.setAttribute("aria-checked", String(readRestoreSession()));
  restoreSwitch.addEventListener("click", () => {
    saveRestoreSession(!readRestoreSession());
    syncRestore();
  });
  syncRestore();
  restoreRow.append(restoreText, restoreSwitch);
  restoreSection.appendChild(restoreRow);

  // --- 탭: 모양 · 환경. 열면 항상 "모양"이 먼저 보이고, ←/→로 전환한다. ---
  const panels: { label: string; nodes: HTMLElement[] }[] = [
    { label: "모양", nodes: [modeSection, colorSection] },
    { label: "환경", nodes: [restoreSection] },
  ];
  const tablist = document.createElement("div");
  tablist.className = "settings-tabs";
  tablist.setAttribute("role", "tablist");
  tablist.setAttribute("aria-label", "설정 분류");
  const tabButtons: HTMLButtonElement[] = [];
  const panelEls: HTMLElement[] = [];
  const showPanel = (index: number) => {
    tabButtons.forEach((b, i) => {
      b.setAttribute("aria-selected", String(i === index));
      b.tabIndex = i === index ? 0 : -1;
      b.classList.toggle("active", i === index);
    });
    panelEls.forEach((p, i) => (p.hidden = i !== index));
  };
  panels.forEach(({ label, nodes }, index) => {
    const tabButton = document.createElement("button");
    tabButton.type = "button";
    tabButton.className = "settings-tab";
    tabButton.setAttribute("role", "tab");
    tabButton.textContent = label;
    tabButton.addEventListener("click", () => showPanel(index));
    tabButton.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
      event.preventDefault();
      const next = (index + (event.key === "ArrowRight" ? 1 : -1) + panels.length) % panels.length;
      showPanel(next);
      tabButtons[next].focus();
    });
    tabButtons.push(tabButton);
    tablist.appendChild(tabButton);

    const panel = document.createElement("div");
    panel.className = "settings-panel";
    panel.setAttribute("role", "tabpanel");
    panel.append(...nodes);
    panelEls.push(panel);
  });
  showPanel(0);

  box.append(heading, tablist, ...panelEls, actions);
  backdrop.appendChild(box);
  document.body.appendChild(backdrop);
  syncModes();

  const close = () => {
    document.removeEventListener("keydown", onKey, true);
    backdrop.remove();
    opened = false;
    opener?.focus?.();
  };
  // Esc: 열린 목록이 있으면 그것만 닫고, 없으면 대화상자를 닫는다. 캡처 단계에서 잡아 에디터 키맵보다 먼저 처리한다.
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    const openSelect = selects.find((s) => s.isOpen());
    if (openSelect) openSelect.close();
    else close();
  };

  closeButton.addEventListener("click", close);
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) close();
  });
  document.addEventListener("keydown", onKey, true);
  modeButtons.get(host.getChoice())?.focus();
}

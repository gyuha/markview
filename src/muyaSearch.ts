/**
 * 편집 전용 모드의 찾기/바꾸기 검색창 — MarkText 데스크톱 `components/search/index.vue`를 프레임워크 없이
 * 옮긴 것(ADR 260822-221032). 구조·문구·동작은 원본 그대로이고, 엔진 호출은 editor.vue의
 * handleSearch·handReplace·handleFindAction과 같다(`muya.search/replace/find`).
 *
 * 원본과 다른 점 하나: 원본은 ⇧Enter도 "다음"이지만, 여기서는 ⇧Enter를 "이전"으로 둔다(⇧⌘G와 짝).
 */
import type { Muya } from "../vendor/muya/src/index";

type SearchKind = "find" | "next" | "previous" | "replace";

interface SearchResult {
  index: number;
  matches: unknown[];
}

// MarkText `assets/icons/searchIcons/*.svg` 그대로.
const ICON_CASE = `<svg viewBox="0 0 20 20" stroke="none" fill-rule="evenodd"><path d="M10.919,13 L9.463,13 C9.29966585,13 9.16550052,12.9591671 9.0605,12.8775 C8.95549947,12.7958329 8.8796669,12.6943339 8.833,12.573 L8.077,10.508 L3.884,10.508 L3.128,12.573 C3.09066648,12.6803339 3.01716722,12.7783329 2.9075,12.867 C2.79783279,12.9556671 2.66366746,13 2.505,13 L1.042,13 L5.018,2.878 L6.943,2.878 L10.919,13 Z M4.367,9.178 L7.594,9.178 L6.362,5.811 C6.30599972,5.66166592 6.24416701,5.48550102 6.1765,5.2825 C6.108833,5.07949898 6.04233366,4.85900119 5.977,4.621 C5.91166634,4.85900119 5.84750032,5.08066564 5.7845,5.286 C5.72149969,5.49133436 5.65966697,5.67099923 5.599,5.825 L4.367,9.178 Z M18.892,13 L18.115,13 C17.9516658,13 17.8233338,12.9755002 17.73,12.9265 C17.6366662,12.8774998 17.5666669,12.7783341 17.52,12.629 L17.366,12.118 C17.1839991,12.2813341 17.0055009,12.4248327 16.8305,12.5485 C16.6554991,12.6721673 16.4746676,12.7759996 16.288,12.86 C16.1013324,12.9440004 15.903001,13.0069998 15.693,13.049 C15.4829989,13.0910002 15.2496679,13.112 14.993,13.112 C14.6896651,13.112 14.4096679,13.0711671 14.153,12.9895 C13.896332,12.9078329 13.6758342,12.7853342 13.4915,12.622 C13.3071657,12.4586658 13.1636672,12.2556679 13.061,12.013 C12.9583328,11.7703321 12.907,11.4880016 12.907,11.166 C12.907,10.895332 12.9781659,10.628168 13.1205,10.3645 C13.262834,10.100832 13.499665,9.8628344 13.831,9.6505 C14.162335,9.43816561 14.6033306,9.2620007 15.154,9.122 C15.7046694,8.9819993 16.3883292,8.90266676 17.205,8.884 L17.205,8.464 C17.205,7.98333093 17.103501,7.62750116 16.9005,7.3965 C16.697499,7.16549885 16.4023352,7.05 16.015,7.05 C15.7349986,7.05 15.5016676,7.08266634 15.315,7.148 C15.1283324,7.21333366 14.9661673,7.28683292 14.8285,7.3685 C14.6908326,7.45016707 14.5636672,7.52366634 14.447,7.589 C14.3303327,7.65433366 14.2020007,7.687 14.062,7.687 C13.9453327,7.687 13.8450004,7.65666697 13.761,7.596 C13.6769996,7.53533303 13.6093336,7.46066711 13.558,7.372 L13.243,6.819 C14.0690041,6.06299622 15.0653275,5.685 16.232,5.685 C16.6520021,5.685 17.0264983,5.75383264 17.3555,5.8915 C17.6845016,6.02916736 17.9633322,6.22049877 18.192,6.4655 C18.4206678,6.71050122 18.5944994,7.00333163 18.7135,7.344 C18.8325006,7.68466837 18.892,8.05799797 18.892,8.464 L18.892,13 Z M15.532,11.922 C15.7093342,11.922 15.8726659,11.9056668 16.022,11.873 C16.1713341,11.8403332 16.3124993,11.7913337 16.4455,11.726 C16.5785006,11.6606663 16.7068327,11.5801671 16.8305,11.4845 C16.9541673,11.3888329 17.0789993,11.2756673 17.205,11.145 L17.205,9.934 C16.7009975,9.95733345 16.279835,10.0004997 15.9415,10.0635 C15.603165,10.1265003 15.3313343,10.2069995 15.126,10.305 C14.9206656,10.4030005 14.7748337,10.5173327 14.6885,10.648 C14.6021662,10.7786673 14.559,10.9209992 14.559,11.075 C14.559,11.3783349 14.6488324,11.5953327 14.8285,11.726 C15.0081675,11.8566673 15.2426652,11.922 15.532,11.922 L15.532,11.922 Z"/></svg>`;
const ICON_WORD = `<svg viewBox="0 0 20 20" stroke="none" fill-rule="evenodd"><rect opacity="0.6" x="1" y="3" width="2" height="6"/><rect opacity="0.6" x="17" y="3" width="2" height="6"/><rect x="6" y="3" width="2" height="6"/><rect x="12" y="3" width="2" height="6"/><rect x="9" y="3" width="2" height="6"/><path d="M4.5,13 L15.5,13 L16,13 L16,12 L15.5,12 L4.5,12 L4,12 L4,13 L4.5,13 L4.5,13 Z"/><path d="M4,10.5 L4,12.5 L4,13 L5,13 L5,12.5 L5,10.5 L5,10 L4,10 L4,10.5 L4,10.5 Z"/><path d="M15,10.5 L15,12.5 L15,13 L16,13 L16,12.5 L16,10.5 L16,10 L15,10 L15,10.5 L15,10.5 Z"/></svg>`;
const ICON_REGEX = `<svg viewBox="0 0 20 20" stroke="none" fill-rule="evenodd"><rect x="3" y="10" width="3" height="3" rx="1"/><rect x="12" y="3" width="2" height="9" rx="1"/><rect transform="translate(13 7.5) rotate(60) translate(-13 -7.5)" x="12" y="3" width="2" height="9" rx="1"/><rect transform="translate(13 7.5) rotate(-60) translate(-13 -7.5)" x="12" y="3" width="2" height="9" rx="1"/></svg>`;
// 원본의 element-plus 아이콘(ArrowDown·ArrowUp·RefreshRight·Switch)과 같은 모양.
const ARROW = (d: string) =>
  `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
const ICON_DOWN = ARROW("M3.5 6l4.5 4.5L12.5 6");
const ICON_UP = ARROW("M3.5 10l4.5-4.5 4.5 4.5");
const ICON_REPLACE_ALL = ARROW("M13 8a5 5 0 1 1-1.5-3.6M13 2.5v2.4h-2.4");
const ICON_REPLACE_ONE = ARROW("M3 5.5h10m-2.5-2.5L13 5.5 10.5 8M13 10.5H3m2.5 2.5L3 10.5 5.5 8");

let bar: HTMLElement | null = null;
let muya: Muya | null = null;
let type: "search" | "replace" = "search";
let isCaseSensitive = false;
let isWholeWord = false;
let isRegexp = false;
let debounce: number | undefined;
let els: {
  arrow: HTMLElement;
  search: HTMLInputElement;
  replace: HTMLInputElement;
  replaceRow: HTMLElement;
  result: HTMLElement;
  error: HTMLElement;
  wrapper: HTMLElement;
  toggles: Record<"isCaseSensitive" | "isWholeWord" | "isRegexp", HTMLElement>;
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", html = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html) node.innerHTML = html;
  return node;
}

function build(): HTMLElement {
  const root = el("div", "search-bar");
  root.hidden = true;
  const arrow = el("div", "left-arrow", ICON_DOWN);
  const controls = el("div", "right-controls");

  const searchRow = el("section", "search");
  const wrapper = el("div", "input-wrapper");
  const search = el("input");
  search.type = "text";
  search.placeholder = "검색";
  const ctrl = el("div", "controls");
  const result = el("span", "search-result");
  const toggle = (cls: string, title: string, icon: string) => {
    const span = el("span", cls, icon);
    span.title = title;
    return span;
  };
  const toggles = {
    isCaseSensitive: toggle("is-case-sensitive", "대소문자 구분", ICON_CASE),
    isWholeWord: toggle("is-whole-word", "전체 단어 선택", ICON_WORD),
    isRegexp: toggle("is-regex", "정규식으로 쿼리 사용", ICON_REGEX),
  };
  ctrl.append(result, toggles.isCaseSensitive, toggles.isWholeWord, toggles.isRegexp);
  const error = el("div", "error-msg");
  error.hidden = true;
  wrapper.append(search, ctrl, error);
  const prev = el("button", "button right", ICON_UP);
  const next = el("button", "button", ICON_DOWN);
  const findButtons = el("div", "button-group");
  findButtons.append(prev, next);
  searchRow.append(wrapper, findButtons);

  const replaceRow = el("section", "replace");
  const replaceWrapper = el("div", "input-wrapper replace-input");
  const replace = el("input");
  replace.type = "text";
  replace.placeholder = "바꿀 내용";
  replaceWrapper.append(replace);
  const all = el("button", "button right", ICON_REPLACE_ALL);
  all.title = "모두 바꾸기";
  const single = el("button", "button", ICON_REPLACE_ONE);
  single.title = "하나 바꾸기";
  const replaceButtons = el("div", "button-group");
  replaceButtons.append(all, single);
  replaceRow.append(replaceWrapper, replaceButtons);

  controls.append(searchRow, replaceRow);
  root.append(arrow, controls);

  els = { arrow, search, replace, replaceRow, result, error, wrapper, toggles };

  arrow.addEventListener("click", () => {
    type = type === "search" ? "replace" : "search";
    render();
  });
  for (const key of Object.keys(toggles) as (keyof typeof toggles)[]) {
    toggles[key].addEventListener("click", () => {
      if (key === "isCaseSensitive") isCaseSensitive = !isCaseSensitive;
      if (key === "isWholeWord") isWholeWord = !isWholeWord;
      if (key === "isRegexp") isRegexp = !isRegexp;
      render();
      searchFn();
    });
  }
  search.addEventListener("input", () => {
    window.clearTimeout(debounce);
    debounce = window.setTimeout(searchFn, 150);
  });
  search.addEventListener("keyup", (event) => {
    if (event.key === "Enter") find(event.shiftKey ? "previous" : "next");
  });
  prev.addEventListener("click", () => find("previous"));
  next.addEventListener("click", () => find("next"));
  all.addEventListener("click", () => replaceFn(false));
  single.addEventListener("click", () => replaceFn(true));

  // 원본처럼 문서 어디서든 Esc(keyup)와 검색창 바깥 클릭으로 닫는다.
  document.addEventListener("keyup", (event) => {
    if (event.key === "Escape" && !root.hidden) closeSearch();
  });
  document.addEventListener("click", (event) => {
    if (root.hidden) return;
    if ((event.target as HTMLElement | null)?.closest(".search-bar")) return;
    closeSearch();
  });
  return root;
}

function show(result: SearchResult | null): void {
  const index = result ? result.index : -1;
  const count = result ? result.matches.length : 0;
  els.result.textContent = `${index + 1} / ${count}`;
}

function render(): void {
  els.arrow.classList.toggle("arrow-right", type === "search");
  els.replaceRow.hidden = type !== "replace";
  els.toggles.isCaseSensitive.classList.toggle("active", isCaseSensitive);
  els.toggles.isWholeWord.classList.toggle("active", isWholeWord);
  els.toggles.isRegexp.classList.toggle("active", isRegexp);
}

function scrollToHighlight(): void {
  muya?.domNode.querySelector(".mu-highlight")?.scrollIntoView({ block: "center" });
}

function setError(message: string): void {
  els.error.textContent = message;
  els.error.hidden = !message;
  els.wrapper.classList.toggle("error", !!message);
}

function searchFn(): void {
  if (!muya) return;
  const value = els.search.value;
  if (isRegexp) {
    try {
      // 빈 문자열과 일치하는 정규식은 검색하지 않는다(원본과 같다).
      if (value && new RegExp(value).test("")) {
        setError(`정규식이 빈 문자열 "${value}"과 일치`);
        return;
      }
    } catch {
      setError(`잘못된 정규식 "${value}"`);
      return;
    }
  }
  setError("");
  show(muya.search(value, { isCaseSensitive, isWholeWord, isRegexp }));
  scrollToHighlight();
}

function find(action: "previous" | "next"): void {
  if (!muya) return;
  show(muya.find(action));
  scrollToHighlight();
}

function replaceFn(isSingle: boolean): void {
  if (!muya) return;
  show(muya.replace(els.replace.value, { isSingle, isCaseSensitive, isWholeWord, isRegexp }));
}

/** 검색창을 닫고 강조를 지운다. 원본처럼 현재 일치 항목을 선택해 둔다(selectHighlight). */
export function closeSearch(): void {
  if (!bar || bar.hidden) return;
  bar.hidden = true;
  els.search.value = "";
  els.replace.value = "";
  setError("");
  muya?.search("", { selectHighlight: true });
}

/**
 * ⌘F·⌘G·⇧⌘G·⌥⌘F. `host`는 검색창이 붙을 자리(활성 탭의 Muya 호스트)다.
 * 열 때 선택한 글자가 있으면 검색어로 채운다(원본의 prefillFromSelection).
 */
export function runSearch(target: Muya, host: HTMLElement, kind: SearchKind): void {
  if (kind === "next" || kind === "previous") {
    if (muya === target) find(kind);
    return;
  }
  if (!bar) bar = build();
  if (muya && muya !== target) closeSearch();
  muya = target;
  if (bar.parentElement !== host) host.appendChild(bar);

  const selected = target.getSelectedText();
  if (selected && !selected.includes("\n")) els.search.value = selected;
  bar.hidden = false;
  type = kind === "replace" ? "replace" : "search";
  render();
  if (kind === "find") {
    els.search.focus();
    // 다시 열면 이전 검색어 위에 덮어 치도록 고른다(원본 #3458).
    els.search.select();
  }
  if (els.search.value) searchFn();
}

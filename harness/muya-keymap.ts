// 편집 모드의 상단 툴바(T01)와 MarkText macOS 단축키(K01–K04). 편집은 DOM 입력·클릭·keydown으로만
// 일으키고, 판정은 getMarkdown()·DOM·IPC 기록으로 한다. 키 이벤트는 앱의 파서가 아니라 이 하네스가
// 원본 가속기 표기에서 스스로 만든다 — 같은 파서로 만들고 맞추면 둘이 함께 틀려도 통과한다.
import keybindingsSource from "../vendor/marktext-desktop/keybindingsDarwin.ts?raw";
import { MARKTEXT_KEYMAP } from "../src/muyaKeymap";
import {
  activeTab,
  calls,
  caretAtEnd,
  check,
  clickMode,
  emitTauri,
  eq,
  guard,
  injectViaSplit,
  muyaOf,
  ready,
  respond,
  selectText,
  wait,
  waitFor,
} from "./lib-muya";
import type { MuyaEditor } from "../src/muya";

/** 원본 파일에서 들이지 않기로 한 것: 브라우저 기본·Muya 클립보드가 맡는 것과 이 앱에 없는 기능. */
const EXCLUDED = new Set(["edit.cut", "edit.copy", "edit.paste", "edit.find-in-folder", "edit.screenshot"]);
const FIND_IDS = new Set(["edit.find", "edit.find-next", "edit.find-previous", "edit.replace"]);

/** 원본의 `['id', 'accelerator']` 중 format·paragraph·edit 이고 키가 있는 것. */
function upstreamEntries(): [string, string][] {
  return [...keybindingsSource.matchAll(/\['((?:format|paragraph|edit)\.[a-z0-9-]+)',\s*'([^']*)'\]/g)]
    .map((m) => [m[1], m[2]] as [string, string])
    .filter(([id, accelerator]) => accelerator !== "" && !EXCLUDED.has(id));
}

/** 가속기 표기 → 실제 키보드가 내는 keydown(물리 키 code 포함). */
function chordEvent(accelerator: string): KeyboardEventInit {
  const parts = accelerator.split("+");
  const key = parts.pop()!;
  const mods = parts.map((p) => p.toLowerCase());
  const codes: Record<string, string> = { "-": "Minus", "=": "Equal", "`": "Backquote" };
  const code = codes[key] ?? (/^\d$/.test(key) ? `Digit${key}` : `Key${key.toUpperCase()}`);
  return {
    key: key.toLowerCase(),
    code,
    metaKey: mods.includes("command") || mods.includes("cmd"),
    altKey: mods.includes("option"),
    shiftKey: mods.includes("shift"),
    ctrlKey: false,
    bubbles: true,
    cancelable: true,
  };
}

function press(target: Element, accelerator: string): void {
  target.dispatchEvent(new KeyboardEvent("keydown", chordEvent(accelerator)));
}

await guard(async () => {
  if (!(await ready())) return check("", "탭이 열렸다", false);
  respond("write_markdown", () => ({ conflict: false, mtime_ms: 2 }));
  const tab = activeTab()!;
  clickMode("edit");
  const muya = (await muyaOf(tab)) as MuyaEditor | null;
  if (!muya) return check("", "Muya가 만들어졌다", false);
  const root = muya.domNode;
  const accel = new Map(upstreamEntries());

  async function load(doc: string): Promise<Element> {
    injectViaSplit(doc);
    clickMode("edit");
    await wait(250);
    return root.querySelector(".mu-content")!;
  }
  const md = () => muya.getMarkdown();

  // ── K01 키맵 표 = 원본 ────────────────────────────────────────────────
  const upstream = upstreamEntries().map(([id, a]) => `${id}=${a}`).sort();
  const ours = MARKTEXT_KEYMAP.map(([id, a]) => `${id}=${a}`).sort();
  eq("K01", "편집 모드 키맵 표 = MarkText keybindingsDarwin.ts의 format·paragraph·edit 42개", { n: ours.length, ours }, { n: 42, ours: upstream });

  // ── K02 42개 효과 ─────────────────────────────────────────────────────
  // format: "beta"를 골라 단축키 → 기대 마크다운
  const formatWant: Record<string, string> = {
    "format.strong": "alpha **beta** gamma",
    "format.emphasis": "alpha *beta* gamma",
    "format.underline": "alpha <u>beta</u> gamma",
    "format.highlight": "alpha <mark>beta</mark> gamma",
    "format.inline-code": "alpha `beta` gamma",
    "format.inline-math": "alpha $beta$ gamma",
    "format.strike": "alpha ~~beta~~ gamma",
    "format.hyperlink": "alpha [beta]() gamma",
    "format.image": "alpha ![beta]() gamma",
  };
  const results: Record<string, boolean> = {};
  for (const [id, want] of Object.entries(formatWant)) {
    const content = await load("alpha beta gamma\n");
    await selectText(content, "beta");
    press(content, accel.get(id)!);
    await wait(150);
    results[id] = md().trim() === want;
    check("", `(K02) ${id} ${accel.get(id)} → ${want}`, results[id], `got=${JSON.stringify(md())}`);
  }
  {
    const content = await load("alpha **beta** gamma\n");
    await selectText(content, "beta");
    press(content, accel.get("format.clear-format")!);
    await wait(150);
    results["format.clear-format"] = md().trim() === "alpha beta gamma";
    check("", "(K02) format.clear-format ⇧⌘R → 서식 지움", results["format.clear-format"], `got=${JSON.stringify(md())}`);
  }

  // paragraph: 문단(또는 지정한 블록) 끝에 캐럿 → 단축키 → 기대
  const paragraphCases: [string, string, () => boolean][] = [
    ...[1, 2, 3, 4, 5, 6].map(
      (n): [string, string, () => boolean] => [`paragraph.heading-${n}`, "문단\n", () => md().trim() === `${"#".repeat(n)} 문단`],
    ),
    ["paragraph.upgrade-heading", "### 문단\n", () => md().trim() === "## 문단"],
    ["paragraph.degrade-heading", "### 문단\n", () => md().trim() === "#### 문단"],
    // 내용이 있는 문단은 코드블록으로 바꿀 수 없어 그 아래에 빈 코드블록을 넣는다(Muya _convertOrInsertBelow).
    ["paragraph.code-fence", "문단\n", () => md().trim() === "문단\n\n```\n\n```"],
    ["paragraph.quote-block", "문단\n", () => md().trim() === "> 문단"],
    ["paragraph.math-formula", "문단\n", () => !!root.querySelector("pre.mu-math-container") && md().includes("$$")],
    ["paragraph.html-block", "문단\n", () => !!root.querySelector(".mu-html-container") && md().includes("문단")],
    ["paragraph.order-list", "문단\n", () => md().trim() === "1. 문단"],
    ["paragraph.bullet-list", "문단\n", () => md().trim() === "- 문단"],
    ["paragraph.task-list", "문단\n", () => md().trim() === "- [ ] 문단"],
    ["paragraph.loose-list-item", "- 하나\n- 둘\n", () => md().trim() === "- 하나\n\n- 둘"],
    ["paragraph.paragraph", "# 문단\n", () => md().trim() === "문단"],
    ["paragraph.horizontal-line", "문단\n", () => root.querySelectorAll(".mu-thematic-break").length === 1],
    ["paragraph.front-matter", "문단\n", () => !!root.querySelector("pre.mu-frontmatter") && md().startsWith("---\n")],
  ];
  for (const [id, doc, ok] of paragraphCases) {
    const content = await load(doc);
    await caretAtEnd(content);
    press(content, accel.get(id)!);
    await wait(200);
    results[id] = ok();
    check("", `(K02) ${id} ${accel.get(id)}`, results[id], `got=${JSON.stringify(md())}`);
  }
  {
    // 표: MarkText처럼 행·열 대화상자(기본 4×3) → 확인 → 그 크기의 표
    const content = await load("문단\n");
    await caretAtEnd(content);
    press(content, accel.get("paragraph.table")!);
    const dialog = await waitFor(() => document.querySelector(".modal-backdrop"));
    const inputs = [...document.querySelectorAll<HTMLInputElement>(".modal-backdrop input[type=number]")].map((i) => i.value);
    document.querySelector<HTMLElement>(".modal-backdrop .modal-confirm")?.click();
    await wait(250);
    const rows = root.querySelectorAll("figure.mu-table tr").length;
    const cols = root.querySelectorAll("figure.mu-table tr:first-child td").length;
    results["paragraph.table"] = !!dialog && JSON.stringify(inputs) === '["4","3"]' && rows === 4 && cols === 3;
    check("", "(K02) paragraph.table ⇧⌘T → 행·열 대화상자(4×3) → 4행 3열 표", results["paragraph.table"], JSON.stringify({ dialog: !!dialog, inputs, rows, cols }));
  }

  // edit (찾기 4개는 검색창 작업에서)
  {
    const content = await load("문단\n");
    await caretAtEnd(content);
    document.execCommand("insertText", false, "X");
    await wait(120);
    press(content, accel.get("edit.undo")!);
    await wait(150);
    results["edit.undo"] = md().trim() === "문단";
    press(root.querySelector(".mu-content")!, accel.get("edit.redo")!);
    await wait(150);
    results["edit.redo"] = md().trim() === "문단X";
    check("", "(K02) edit.undo ⌘Z / edit.redo ⇧⌘Z", results["edit.undo"] && results["edit.redo"], `got=${JSON.stringify(md())}`);
  }
  {
    // MarkText의 ⌘A: 첫 번째는 그 블록 전체, 두 번째는 문서 전체
    const content = await load("첫째\n\n둘째\n");
    await caretAtEnd(content);
    press(content, accel.get("edit.select-all")!);
    await wait(100);
    const first = getSelection()?.toString() ?? "";
    press(root.querySelector(".mu-content")!, accel.get("edit.select-all")!);
    await wait(100);
    const second = getSelection()?.toString() ?? "";
    results["edit.select-all"] = first.trim() === "첫째" && second.includes("첫째") && second.includes("둘째");
    check("", "(K02) edit.select-all ⌘A → 블록 → 문서 전체", results["edit.select-all"], JSON.stringify({ first, second }));
  }
  {
    const content = await load("문단\n");
    await caretAtEnd(content);
    let copied = 0;
    const original = muya.copyAsRich.bind(muya);
    muya.copyAsRich = () => {
      copied++;
    };
    press(content, accel.get("edit.copy-as-rich")!);
    await wait(80);
    muya.copyAsRich = original;
    results["edit.copy-as-rich"] = copied === 1;
    check("", "(K02) edit.copy-as-rich ⇧⌘C → 엔진의 서식 있는 복사", results["edit.copy-as-rich"], `calls=${copied}`);
  }
  {
    // ⇧⌘V는 MarkText처럼 메뉴 가속기다 — 실제 창에서는 키가 웹뷰에 오지 않고, 메뉴가 Rust에서 클립보드를 읽어
    // "paste-as-plaintext" 이벤트로 넘긴다(⌘S·⌘W와 같은 길). 여기서는 그 메뉴 이벤트를 흉내 낸다.
    const content = await load("문단\n");
    await caretAtEnd(content);
    emitTauri("paste-as-plaintext", "붙인글");
    await waitFor(() => md().includes("붙인글"), 2000);
    results["edit.paste-as-plaintext"] = md().includes("붙인글");
    check("", "(K02) edit.paste-as-plaintext ⇧⌘V(메뉴) → 클립보드 글 붙여넣기", results["edit.paste-as-plaintext"], `got=${JSON.stringify(md())}`);
  }
  for (const [id, want] of [
    ["edit.duplicate", (m: string) => m.trim() === "문단\n\n문단"],
    ["edit.create-paragraph", () => root.querySelectorAll(".mu-paragraph").length === 2],
    ["edit.delete-paragraph", (m: string) => !m.includes("지울문단") && m.includes("남는문단")],
  ] as [string, (m: string) => boolean][]) {
    const content = await load(id === "edit.delete-paragraph" ? "지울문단\n\n남는문단\n" : "문단\n");
    await caretAtEnd(content);
    press(content, accel.get(id)!);
    await wait(200);
    results[id] = want(md());
    check("", `(K02) ${id} ${accel.get(id)}`, results[id], `got=${JSON.stringify(md())}`);
  }

  {
    // 찾기 계열: 고른 글자로 검색창이 채워지고, ⌘G·⇧⌘G는 검색 입력에 포커스가 있어도 동작한다(메뉴 단축키).
    const content = await load("cat a\n\ncat b\n\ncat c\n");
    await selectText(content, "cat");
    press(content, accel.get("edit.find")!);
    await wait(400);
    const bar = document.querySelector<HTMLElement>(".search-bar");
    const input = bar?.querySelector<HTMLInputElement>(".search input");
    const result = () => bar?.querySelector(".search-result")?.textContent?.trim();
    results["edit.find"] = !!bar && !bar.hidden && document.activeElement === input && input?.value === "cat" && result() === "1 / 3";
    press(input!, accel.get("edit.find-next")!);
    await wait(80);
    results["edit.find-next"] = result() === "2 / 3";
    press(input!, accel.get("edit.find-previous")!);
    await wait(80);
    results["edit.find-previous"] = result() === "1 / 3";
    document.body.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", bubbles: true }));
    await wait(100);
    press(root.querySelector(".mu-content")!, accel.get("edit.replace")!);
    await wait(100);
    const replaceRow = bar?.querySelector<HTMLElement>(".replace");
    results["edit.replace"] = !!bar && !bar.hidden && !!replaceRow && !replaceRow.hidden;
    for (const id of FIND_IDS) check("", `(K02) ${id} ${accel.get(id)}`, results[id], `result=${result()} value=${input?.value}`);
    document.body.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", bubbles: true }));
    await wait(100);
  }

  const failed = [...accel.keys()].filter((id) => !results[id]);
  check("K02", "MarkText 단축키 42개를 Muya 안에서 누르면 각각 기대 효과", failed.length === 0 && Object.keys(results).length === 42, `실패·미확인: ${failed.join(" ")}`);

  // ── T01 상단 툴바 14개 ────────────────────────────────────────────────
  const toolbarCases: [string, string, "select" | "caret", string][] = [
    ["bold", "alpha beta gamma\n", "select", "alpha **beta** gamma"],
    ["italic", "alpha beta gamma\n", "select", "alpha *beta* gamma"],
    ["strike", "alpha beta gamma\n", "select", "alpha ~~beta~~ gamma"],
    ["code", "alpha beta gamma\n", "select", "alpha `beta` gamma"],
    ["link", "alpha beta gamma\n", "select", "alpha [beta]() gamma"],
    ["image", "alpha beta gamma\n", "select", "alpha ![beta]() gamma"],
    ["h1", "문단\n", "caret", "# 문단"],
    ["h2", "문단\n", "caret", "## 문단"],
    ["h3", "문단\n", "caret", "### 문단"],
    ["h0", "## 문단\n", "caret", "문단"],
    ["list", "문단\n", "caret", "- 문단"],
    ["ordered", "문단\n", "caret", "1. 문단"],
    ["codeblock", "문단\n", "caret", "문단\n\n```\n\n```"],
    ["quote", "문단\n", "caret", "> 문단"],
  ];
  const toolbar: Record<string, string> = {};
  for (const [id, doc, how, want] of toolbarCases) {
    const content = await load(doc);
    if (how === "select") await selectText(content, "beta");
    else await caretAtEnd(content);
    const button = document.querySelector<HTMLButtonElement>(`#format [data-format="${id}"]`)!;
    button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    if (!button.disabled) button.click();
    await waitFor(() => md().trim() === want, 1000);
    toolbar[id] = button.disabled ? "(비활성)" : md().trim() === want ? "ok" : JSON.stringify(md().trim());
  }
  const t01 = Object.values(toolbar).every((v) => v === "ok") && Object.keys(toolbar).length === 14;
  check("T01", "편집 모드 상단 툴바 14개가 활성이고 각각 Muya에 서식/블록을 적용", t01, JSON.stringify(toolbar));

  // ── K03 ⇧⌘R은 서식 지우기(다시 읽기 아님), ⌘R은 다시 읽기 ────────────────
  {
    const content = await load("alpha **beta** gamma\n");
    emitTauri("save");
    await waitFor(() => !tab.dirty);
    const reads = () => calls().filter((c) => c.cmd === "read_markdown").length;
    await selectText(content, "beta");
    const before = reads();
    press(content, "Shift+Command+R");
    await wait(300);
    const cleared = md().trim() === "alpha beta gamma" && reads() === before;
    emitTauri("save");
    await waitFor(() => !tab.dirty);
    const beforePlain = reads();
    press(root.querySelector(".mu-content")!, "Command+R");
    await waitFor(() => reads() > beforePlain, 2000);
    const reloaded = reads() === beforePlain + 1;
    check("K03", "편집 모드 ⇧⌘R = 서식 지우기(새로고침 아님), Shift 없는 ⌘R = 새로고침", cleared && reloaded, JSON.stringify({ cleared, reloaded, md: md() }));
  }

  // ── K04 Muya에 포커스가 있어도 기존 단축키 ─────────────────────────────
  {
    const content = await load("alpha beta gamma\n");
    await caretAtEnd(content);
    const fkey = (key: string) => content.dispatchEvent(new KeyboardEvent("keydown", { key, code: key, bubbles: true, cancelable: true }));
    fkey("F2");
    const f2 = tab.mode === "split";
    fkey("F1");
    await wait(200);
    const f1 = tab.mode === "edit";
    await caretAtEnd(root.querySelector(".mu-content")!);
    const mdBefore = md();
    root.querySelector(".mu-content")!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "e", code: "KeyE", metaKey: true, bubbles: true, cancelable: true }),
    );
    await wait(150);
    const cmdE = tab.mode === "view" && md() === mdBefore;
    fkey("F3");
    const f3 = tab.mode === "view";
    clickMode("edit");
    await wait(200);
    await caretAtEnd(root.querySelector(".mu-content")!);
    document.execCommand("insertText", false, "S");
    await wait(120);
    const typed = tab.dirty;
    const writesBefore = calls().filter((c) => c.cmd === "write_markdown").length;
    emitTauri("save");
    // 목 IPC는 호출 시작 때 기록된다 — 응답 뒤 수정됨이 풀릴 때까지 기다린다.
    await waitFor(() => calls().filter((c) => c.cmd === "write_markdown").length > writesBefore && !tab.dirty, 2000);
    const save = !tab.dirty && calls().filter((c) => c.cmd === "write_markdown").length === writesBefore + 1;
    const closesBefore = calls().filter((c) => c.cmd === "plugin:window|close").length;
    emitTauri("close-tab");
    await waitFor(() => calls().filter((c) => c.cmd === "plugin:window|close").length > closesBefore, 2000);
    const close = calls().filter((c) => c.cmd === "plugin:window|close").length === closesBefore + 1;
    check("K04", "Muya 포커스에서도 F1·F2·F3·⌘E(인라인 코드 안 됨)·⌘S·⌘W가 기존대로", f1 && f2 && f3 && cmdE && save && close, JSON.stringify({ f1, f2, f3, cmdE, typed, save, close, last: calls().slice(-4).map((c) => c.cmd) }));
  }
});

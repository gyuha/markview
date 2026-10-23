// AI 에이전트 설정 — 설정 창의 "에이전트" 탭(빠른 액션 편집 · CLI 경로). 실제 DOM 이벤트로 구동하고 DOM·저장소·모킹 IPC로만 판정한다.
// 판정할 ID는 harness/required-agent.txt(B01~B11).
// 계약: 설정 창 `.modal.settings`의 탭 `[role=tab]`("에이전트") · `[data-qa-row]`(안에 `[data-qa-name]` input, `[data-qa-text]` textarea, `[data-qa-delete]`)
//   · `[data-qa-add]` · `[data-qa-reset]` · `[data-qa-error]` · `[data-cli-row="<id>"]`(안에 `[data-cli-path]`, `[data-cli-input]`, `[data-cli-set]`, `[data-cli-error]`) · `[data-cli-refind]`
//   · 저장소 키 `markview.agent.actions` · IPC `detect_agents {refresh?}` · `set_agent_path {preset, path}`.
import { calls, check, guard, ready, respond, tabs, visible, wait, waitFor } from "./lib-muya";

const params = new URLSearchParams(location.search);
const KEY = "markview.agent.actions";
const DEFAULT_NAMES = ["번역", "요약", "맞춤법·문장 다듬기", "목차 생성"];

const $ = (sel: string, root: ParentNode = document) => root.querySelector<HTMLElement>(sel);
const all = (sel: string, root: ParentNode = document) => [...root.querySelectorAll<HTMLElement>(sel)];
const text = (el: Element | null | undefined) => (el?.textContent ?? "").trim();
const callsOf = (cmd: string) => calls().filter((c) => c.cmd === cmd);
const settings = () => $(".modal.settings");
const chips = () => all("[data-agent-chip]").map(text);
const rows = () => all("[data-qa-row]", settings() ?? document);
const names = () => rows().map((r) => ($("[data-qa-name]", r) as HTMLInputElement).value);
const stored = () => localStorage.getItem(KEY);

function edit(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

/** 같은 저장소를 쓰는 "새 창"(iframe)에서 패널을 열어 칩 이름을 읽는다. */
async function chipsInNewWindow(): Promise<string[] | null> {
  const frame = document.createElement("iframe");
  frame.style.cssText = "position:fixed;left:-2000px;top:0;width:1100px;height:700px";
  frame.src = `${location.pathname}?files=1&child=1`;
  document.body.append(frame);
  const win = await waitFor(() => {
    const d = frame.contentDocument;
    return d && d.querySelector(".pane") && d.querySelector("[data-agent-toggle]") ? frame.contentWindow : null;
  }, 15000);
  let result: string[] | null = null;
  if (win) {
    await wait(300);
    win.document.querySelector<HTMLElement>("[data-agent-toggle]")!.click();
    await waitFor(() => win.document.querySelector("[data-agent-chip]") || null, 5000);
    await wait(200);
    result = [...win.document.querySelectorAll("[data-agent-chip]")].map((c) => (c.textContent ?? "").trim());
  }
  frame.remove();
  return result;
}

async function openAgentTab(): Promise<void> {
  if (!settings()) {
    $("#settings-button")!.click();
    await waitFor(() => settings());
  }
  const tab = all("[role=tab]", settings()!).find((t) => text(t) === "에이전트");
  tab?.click();
  await wait(200);
}

async function main(): Promise<void> {
  if (params.has("child")) return;
  localStorage.removeItem(KEY);
  await ready();

  // 모킹: 찾은 것/못 찾은 것이 있고, set_agent_path가 성공하면 그 프리셋이 찾은 것으로 바뀐다.
  const found: Record<string, string | null> = { claude: "/x/claude", codex: "/x/codex", opencode: null };
  let setMode: "ok" | "fail" = "ok";
  respond("detect_agents", () => [
    { id: "claude", name: "Claude Code", path: found.claude },
    { id: "codex", name: "Codex", path: found.codex },
    { id: "opencode", name: "OpenCode", path: found.opencode },
  ]);
  respond("set_agent_path", (args) => {
    if (setMode === "fail") throw "파일 이름이 opencode이어야 합니다";
    const a = args as { preset: string; path: string };
    found[a.preset] = a.path === "" ? null : a.path;
    return null;
  });

  // 패널을 먼저 열어 둔다 — 설정을 고치면 열려 있는 패널의 칩이 따라와야 한다.
  $("#toolbar-right [data-agent-toggle]")!.click();
  await waitFor(() => visible($("[data-agent-prompt]")), 5000);
  await wait(300);
  const detectBase = callsOf("detect_agents").length;

  // 설정을 열기만 해서는 detect_agents가 불리지 않는다. "에이전트" 탭을 보면 불린다.
  $("#settings-button")!.click();
  await waitFor(() => settings());
  await wait(200);
  const afterOpen = callsOf("detect_agents").length - detectBase;
  await openAgentTab();
  await waitFor(() => callsOf("detect_agents").length > detectBase, 3000);
  const section = $("[data-agent-settings]");
  check(
    "B01",
    "설정 창에 '에이전트' 탭이 있고 빠른 액션이 기본 4개이며 이름이 패널 칩과 같다. 열기만 해서는 `detect_agents`가 불리지 않고 탭을 보면 불린다",
    !!section && JSON.stringify(names()) === JSON.stringify(DEFAULT_NAMES) && JSON.stringify(chips()) === JSON.stringify(DEFAULT_NAMES) && afterOpen === 0,
    `section=${!!section} names=${JSON.stringify(names())} chips=${JSON.stringify(chips())} afterOpen=${afterOpen}`,
  );

  // B02 — 이름 수정
  const first = $("[data-qa-name]", rows()[0]) as HTMLInputElement;
  edit(first, "번역(영→한)");
  await wait(150);
  const saved = (() => {
    try {
      return JSON.parse(stored() ?? "null") as { name: string; text: string }[] | null;
    } catch {
      return null;
    }
  })();
  const other = await chipsInNewWindow();
  check(
    "B02",
    "이름을 고치면 열려 있는 패널의 칩이 바뀌고 저장소에 남으며 새 창에서도 고친 목록이 나온다",
    chips()[0] === "번역(영→한)" && saved?.[0]?.name === "번역(영→한)" && saved.length === 4 && other?.[0] === "번역(영→한)" && other.length === 4,
    `chips=${JSON.stringify(chips())} saved=${JSON.stringify(saved?.map((a) => a.name))} newWindow=${JSON.stringify(other)}`,
  );

  // B06 — 고친 문장이 칩에서 입력창으로 간다.
  edit($("[data-qa-text]", rows()[1]) as HTMLTextAreaElement, "요약해서 맨 위에 넣어 줘(고친 문장)");
  await wait(120);
  const prompt = $("[data-agent-prompt]") as HTMLTextAreaElement;
  prompt.value = "";
  prompt.dispatchEvent(new Event("input", { bubbles: true }));
  all("[data-agent-chip]")[1]?.click();
  await wait(100);
  check("B06", "고친 문장이 칩을 눌렀을 때 지시 입력창에 채워진다", prompt.value === "요약해서 맨 위에 넣어 줘(고친 문장)", `value=${JSON.stringify(prompt.value)}`);

  // B04 — 비우면 거부
  const beforeBad = stored();
  const chipsBefore = chips();
  edit($("[data-qa-name]", rows()[2]) as HTMLInputElement, "   ");
  await wait(120);
  const errShown = visible($("[data-qa-error]", settings()!)) && text($("[data-qa-error]", settings()!)).length > 0;
  const textEdit = $("[data-qa-text]", rows()[3]) as HTMLTextAreaElement;
  const textBefore = textEdit.value;
  edit(textEdit, "");
  await wait(120);
  check(
    "B04",
    "이름이나 문장을 비우면 오류가 보이고 저장소와 칩은 그대로다",
    errShown && stored() === beforeBad && JSON.stringify(chips()) === JSON.stringify(chipsBefore) && textBefore.length > 0,
    `err=${errShown} storageSame=${stored() === beforeBad} chipsSame=${JSON.stringify(chips()) === JSON.stringify(chipsBefore)}`,
  );
  // 고쳐서 오류를 풀어 둔다.
  edit($("[data-qa-name]", rows()[2]) as HTMLInputElement, "맞춤법·문장 다듬기");
  edit(textEdit, textBefore);
  await wait(120);

  // B03 — 추가·삭제·전부 삭제
  const n0 = rows().length;
  $("[data-qa-add]", settings()!)!.click();
  await wait(150);
  const afterAdd = { rows: rows().length, chips: chips().length };
  $("[data-qa-delete]", rows()[rows().length - 1])!.click();
  await wait(150);
  const afterDelete = { rows: rows().length, chips: chips().length };
  while (rows().length > 0) {
    $("[data-qa-delete]", rows()[0])!.click();
    await wait(60);
  }
  await wait(150);
  const empty = { rows: rows().length, chips: chips().length };
  const otherEmpty = await chipsInNewWindow();
  check(
    "B03",
    "추가하면 행과 칩이 하나 늘고, 삭제하면 줄며, 모두 지우면 칩이 하나도 없고 새 창에도 남는다",
    afterAdd.rows === n0 + 1 && afterAdd.chips === n0 + 1 && afterDelete.rows === n0 && afterDelete.chips === n0 && empty.rows === 0 && empty.chips === 0 && otherEmpty?.length === 0,
    `add=${JSON.stringify(afterAdd)} del=${JSON.stringify(afterDelete)} empty=${JSON.stringify(empty)} newWindow=${JSON.stringify(otherEmpty)}`,
  );

  // B05 — 복원
  $("[data-qa-reset]", settings()!)!.click();
  await wait(200);
  check("B05", "기본값으로 복원하면 기본 4개로 돌아가고 칩도 같아진다", JSON.stringify(names()) === JSON.stringify(DEFAULT_NAMES) && JSON.stringify(chips()) === JSON.stringify(DEFAULT_NAMES), `names=${JSON.stringify(names())} chips=${JSON.stringify(chips())}`);

  // B07 — CLI 경로 목록
  const cliRows = all("[data-cli-row]", settings()!);
  const rowOf = (id: string) => cliRows.find((r) => r.dataset.cliRow === id);
  check(
    "B07",
    "CLI 경로 목록에 프리셋 3개가 있고 찾은 것은 경로를, 못 찾은 것은 '없음'을 보인다",
    cliRows.length === 3 && text($("[data-cli-path]", rowOf("claude")!)).includes("/x/claude") && text($("[data-cli-path]", rowOf("codex")!)).includes("/x/codex") && text($("[data-cli-path]", rowOf("opencode")!)).includes("없음"),
    `rows=${cliRows.map((r) => r.dataset.cliRow)} paths=${JSON.stringify(cliRows.map((r) => text($("[data-cli-path]", r))))}`,
  );

  // B08 — 다시 찾기
  const refindBase = callsOf("detect_agents").length;
  $("[data-cli-refind]", settings()!)!.click();
  await waitFor(() => callsOf("detect_agents").length > refindBase, 3000);
  await wait(150);
  const refindCalls = callsOf("detect_agents").slice(refindBase);
  check("B08", "다시 찾기는 `detect_agents`를 `{ refresh: true }`로 정확히 1번 부른다", refindCalls.length === 1 && (refindCalls[0].args as { refresh?: boolean } | undefined)?.refresh === true, `calls=${JSON.stringify(refindCalls.map((c) => c.args))}`);

  // B09 — 지정 성공
  const op = () => all("[data-cli-row]", settings()!).find((r) => r.dataset.cliRow === "opencode")!;
  const setBase = callsOf("set_agent_path").length;
  edit($("[data-cli-input]", op()) as HTMLInputElement, "/opt/homebrew/bin/opencode");
  $("[data-cli-set]", op())!.click();
  await waitFor(() => callsOf("set_agent_path").length > setBase, 3000);
  await wait(300);
  const setCalls = callsOf("set_agent_path").slice(setBase);
  const opOption = ([...($("[data-agent-preset]") as HTMLSelectElement).options]).find((o) => o.value === "opencode");
  check(
    "B09",
    "지정하면 `set_agent_path`가 `{ preset, path }`로 1번 불리고 성공하면 목록과 패널의 프리셋 선택이 새 결과를 따른다",
    setCalls.length === 1 && JSON.stringify(setCalls[0].args) === JSON.stringify({ preset: "opencode", path: "/opt/homebrew/bin/opencode" }) && text($("[data-cli-path]", op())).includes("/opt/homebrew/bin/opencode") && opOption?.disabled === false,
    `calls=${JSON.stringify(setCalls.map((c) => c.args))} path=${JSON.stringify(text($("[data-cli-path]", op())))} option=${opOption?.disabled}`,
  );

  // B10 — 거부
  setMode = "fail";
  const pathBefore = text($("[data-cli-path]", op()));
  edit($("[data-cli-input]", op()) as HTMLInputElement, "/bin/sh");
  $("[data-cli-set]", op())!.click();
  await wait(300);
  const errText = text($("[data-cli-error]", op()));
  check("B10", "거부되면 그 행에 오류가 보이고 경로 표시는 그대로다", visible($("[data-cli-error]", op())) && errText.includes("opencode") && text($("[data-cli-path]", op())) === pathBefore, `error=${JSON.stringify(errText)} path=${JSON.stringify(text($("[data-cli-path]", op())))}`);
  setMode = "ok";

  // B11 — 비우고 지정 = 지정 지우기
  const clearBase = callsOf("set_agent_path").length;
  edit($("[data-cli-input]", op()) as HTMLInputElement, "");
  $("[data-cli-set]", op())!.click();
  await waitFor(() => callsOf("set_agent_path").length > clearBase, 3000);
  const clearCalls = callsOf("set_agent_path").slice(clearBase);
  check("B11", "입력을 비우고 지정하면 `set_agent_path`가 `path: \"\"`로 불린다", clearCalls.length === 1 && (clearCalls[0].args as { path?: string }).path === "" && (clearCalls[0].args as { preset?: string }).preset === "opencode", `calls=${JSON.stringify(clearCalls.map((c) => c.args))}`);

  localStorage.removeItem(KEY);
  void tabs;
}

void guard(main);

// 프로바이더 탭 — 설정 창의 "프로바이더" 탭과 에이전트 패널의 연동. 실제 DOM 이벤트로 구동하고 DOM·모킹 IPC 호출 기록으로만 판정한다.
// 판정할 ID는 harness/required-agent.txt(P01~P10).
// 계약: 설정 창 `.modal.settings`의 탭 "프로바이더" · `[data-provider-row=<id>]`(안에 `[data-provider-enabled]` role=switch, `[data-provider-model]`,
//   `[data-provider-error]`, `[data-provider-diagnose]`, `[data-provider-test]`, `[data-provider-result]`) · `[data-cli-row]`·`[data-cli-refind]`
//   · 패널 `[data-agent-preset]`·`[data-agent-send]`·`[data-agent-empty]`
//   · IPC `set_provider_settings {preset, enabled?, model?}` · `provider_diagnostic {preset}` · `test_provider {preset}` · `run_agent {preset,prompt,text,path}`.
import { calls, check, guard, ready, respond, visible, wait, waitFor } from "./lib-muya";

const $ = (sel: string, root: ParentNode = document) => root.querySelector<HTMLElement>(sel);
const all = (sel: string, root: ParentNode = document) => [...root.querySelectorAll<HTMLElement>(sel)];
const text = (el: Element | null | undefined) => (el?.textContent ?? "").trim();
const callsOf = (cmd: string) => calls().filter((c) => c.cmd === cmd);
const settings = () => $(".modal.settings");
const rowOf = (id: string) => $(`[data-provider-row="${id}"]`, settings() ?? document);
const part = (name: string) => $(`[data-agent-${name}]`);
const IDS = ["claude", "codex", "opencode"];
const NAMES: Record<string, string> = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode" };

const state: Record<string, { enabled: boolean; model: string | null }> = {
  claude: { enabled: true, model: null },
  codex: { enabled: true, model: null },
  opencode: { enabled: true, model: null },
};
let testResolve: ((text: string) => void) | null = null;
let diagnoseFail = false;

async function openSettingsTab(name: string): Promise<void> {
  if (!settings()) {
    $("#settings-button")!.click();
    await waitFor(() => settings());
  }
  all("[role=tab]", settings()!).find((t) => text(t) === name)?.click();
  await wait(250);
}

function enabledOf(id: string): HTMLButtonElement | null {
  return $("[data-provider-enabled]", rowOf(id) ?? document) as HTMLButtonElement | null;
}

async function setEnabled(id: string, want: boolean): Promise<void> {
  const b = enabledOf(id);
  if (!b || (b.getAttribute("aria-checked") === "true") === want) return;
  b.click();
  await waitFor(() => (enabledOf(id)?.getAttribute("aria-checked") === "true") === want, 3000);
  await wait(150);
}

function presetOption(id: string): HTMLOptionElement | undefined {
  return [...((part("preset") as HTMLSelectElement | null)?.options ?? [])].find((o) => o.value === id);
}

async function main(): Promise<void> {
  await ready();
  respond("detect_agents", () =>
    IDS.map((id) => ({ id, name: NAMES[id], path: `/x/${id}`, enabled: state[id].enabled, model: state[id].model })),
  );
  respond("set_provider_settings", (args) => {
    const a = args as { preset: string; enabled?: boolean; model?: string };
    if (a.model !== undefined && a.model !== "" && !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/.test(a.model.trim())) {
      throw "모델 이름은 영문자·숫자와 . _ : / @ + - 만 쓸 수 있고 영문자나 숫자로 시작해야 합니다";
    }
    if (a.enabled !== undefined) state[a.preset].enabled = a.enabled;
    if (a.model !== undefined) state[a.preset].model = a.model.trim() === "" ? null : a.model.trim();
    return null;
  });
  respond("provider_diagnostic", (args) => {
    const id = (args as { preset: string }).preset;
    return diagnoseFail
      ? { installed: true, path: `/x/${id}`, version: null, error: "로그인이 필요합니다" }
      : { installed: true, path: `/x/${id}`, version: `${id} 9.9.9`, error: null };
  });
  respond("test_provider", () => new Promise<string>((resolve) => (testResolve = resolve)));
  respond("run_agent", () => new Promise<string>(() => {}));
  respond("cancel_agent", () => null);

  // 패널을 먼저 열어 둔다 — 설정을 고치면 열려 있는 패널이 따라와야 한다.
  $("#toolbar-right [data-agent-toggle]")!.click();
  await waitFor(() => visible(part("prompt")), 5000);
  await wait(300);

  // P05의 앞부분 — 설정을 열고 프로바이더 탭을 보는 것만으로는 진단이 불리지 않는다.
  await openSettingsTab("프로바이더");
  await waitFor(() => rowOf("claude"), 3000);
  const diagnoseOnOpen = callsOf("provider_diagnostic").length;
  const testOnOpen = callsOf("test_provider").length;

  // P01
  const rows = all("[data-provider-row]", settings()!);
  check(
    "P01",
    "'프로바이더' 탭에 provider 행이 claude·codex·opencode 3개 있다",
    rows.length === 3 && IDS.every((id) => !!rowOf(id)) && all("[role=tab]", settings()!).some((t) => text(t) === "프로바이더" && t.getAttribute("aria-selected") === "true"),
    `rows=${rows.map((r) => r.dataset.providerRow)}`,
  );

  // P02
  const initial = IDS.map((id) => enabledOf(id)?.getAttribute("aria-checked"));
  const roles = IDS.map((id) => enabledOf(id)?.getAttribute("role"));
  const base2 = callsOf("set_provider_settings").length;
  await setEnabled("claude", false);
  const made2 = callsOf("set_provider_settings").slice(base2);
  check(
    "P02",
    "토글은 role=switch이고 처음엔 켜짐이며, 끄면 `{ preset, enabled: false }`로 1번 불리고 `aria-checked`가 false가 된다",
    initial.every((v) => v === "true") && roles.every((r) => r === "switch") && made2.length === 1 && JSON.stringify(made2[0].args) === JSON.stringify({ preset: "claude", enabled: false }) && enabledOf("claude")?.getAttribute("aria-checked") === "false",
    `initial=${initial} roles=${roles} calls=${JSON.stringify(made2.map((c) => c.args))} now=${enabledOf("claude")?.getAttribute("aria-checked")}`,
  );

  // P03 — 열려 있는 패널에 바로 반영: claude는 고를 수 없고 선택은 다른 provider로 옮겨 간다. 전부 끄면 보내기 비활성 + 안내.
  const select = part("preset") as HTMLSelectElement;
  const claudeBlocked = presetOption("claude")?.disabled === true && select.value !== "claude" && select.value !== "";
  await setEnabled("codex", false);
  await setEnabled("opencode", false);
  const prompt = part("prompt") as HTMLTextAreaElement;
  prompt.value = "무언가 해 줘";
  prompt.dispatchEvent(new Event("input", { bubbles: true }));
  await wait(150);
  const sendDisabled = (part("send") as HTMLButtonElement).disabled;
  const hint = part("empty");
  const hintShown = !!hint && visible(hint) && text(hint).length > 0;
  check("P03", "비활성 provider는 패널 선택에서 고를 수 없고 선택이 옮겨 가며, 전부 비활성이면 보내기 비활성 + 안내가 보인다", claudeBlocked && sendDisabled && hintShown, `claudeBlocked=${claudeBlocked} sendDisabled=${sendDisabled} hint=${hintShown}`);

  // P09 — 켜면 패널이 바로 따라온다(패널을 닫았다 열지 않는다).
  await setEnabled("codex", true);
  const codexBack = presetOption("codex")?.disabled === false && select.value === "codex" && !(part("send") as HTMLButtonElement).disabled;
  await setEnabled("claude", true);
  await setEnabled("opencode", true);
  const allBack = IDS.every((id) => presetOption(id)?.disabled === false);
  check("P09", "provider를 껐다 켜면 패널을 다시 열지 않아도 선택 목록이 바로 따라 바뀐다", codexBack && allBack && visible(part("prompt")), `codexBack=${codexBack} allBack=${allBack}`);

  // P04 — 모델 저장과 거부
  const modelInput = $("[data-provider-model]", rowOf("claude")!) as HTMLInputElement;
  const base4 = callsOf("set_provider_settings").length;
  modelInput.value = "haiku";
  modelInput.dispatchEvent(new Event("change", { bubbles: true }));
  await wait(300);
  const saved = callsOf("set_provider_settings").slice(base4);
  const savedOk = saved.length === 1 && JSON.stringify(saved[0].args) === JSON.stringify({ preset: "claude", model: "haiku" });
  const freshInput = $("[data-provider-model]", rowOf("claude")!) as HTMLInputElement;
  const shownBack = freshInput.value === "haiku";
  freshInput.value = "--yolo";
  freshInput.dispatchEvent(new Event("change", { bubbles: true }));
  await wait(300);
  const errEl = $("[data-provider-error]", rowOf("claude")!);
  const input4 = $("[data-provider-model]", rowOf("claude")!) as HTMLInputElement;
  check(
    "P04",
    "모델 저장은 `{ preset, model }`로 1번 불리고, 거부된 값은 행에 오류가 보이며 입력이 저장된 값으로 돌아간다",
    savedOk && shownBack && !!errEl && visible(errEl) && text(errEl).length > 0 && input4.value === "haiku",
    `saved=${JSON.stringify(saved.map((c) => c.args))} err=${text(errEl)} input=${input4.value}`,
  );

  // P05 — 버전 확인은 누를 때만
  const diagBtn = $("[data-provider-diagnose]", rowOf("codex")!) as HTMLButtonElement;
  const base5 = callsOf("provider_diagnostic").length;
  diagBtn.click();
  await waitFor(() => callsOf("provider_diagnostic").length > base5, 3000);
  await wait(200);
  const diagCalls = callsOf("provider_diagnostic").slice(base5);
  const resultText = text($("[data-provider-result]", rowOf("codex")!));
  check(
    "P05",
    "프로바이더 탭을 보는 것만으로는 진단이 불리지 않고, 버전 확인을 누르면 `{ preset }`로 1번 불리며 결과가 행에 보인다",
    diagnoseOnOpen === 0 && diagCalls.length === 1 && JSON.stringify(diagCalls[0].args) === JSON.stringify({ preset: "codex" }) && resultText.includes("9.9.9"),
    `onOpen=${diagnoseOnOpen} calls=${JSON.stringify(diagCalls.map((c) => c.args))} result=${resultText}`,
  );
  diagnoseFail = true;
  ($("[data-provider-diagnose]", rowOf("codex")!) as HTMLButtonElement).click();
  await wait(250);
  diagnoseFail = false;

  // P06 — 연결 시험은 누를 때만, 진행 중 비활성
  const testBtn = () => $("[data-provider-test]", rowOf("opencode")!) as HTMLButtonElement;
  const base6 = callsOf("test_provider").length;
  testBtn().click();
  await waitFor(() => callsOf("test_provider").length > base6, 3000);
  await wait(100);
  const duringDisabled = testBtn().disabled;
  testResolve?.("OK (7초)");
  await waitFor(() => !testBtn().disabled, 3000);
  await wait(100);
  const testCalls = callsOf("test_provider").slice(base6);
  const testResult = text($("[data-provider-result]", rowOf("opencode")!));
  check(
    "P06",
    "연결 시험은 누르기 전에는 불리지 않고, 누르면 `{ preset }`로 1번 불리며 진행 중 비활성이고 끝나면 결과가 보인다",
    testOnOpen === 0 && testCalls.length === 1 && JSON.stringify(testCalls[0].args) === JSON.stringify({ preset: "opencode" }) && duringDisabled && testResult.includes("OK"),
    `onOpen=${testOnOpen} calls=${JSON.stringify(testCalls.map((c) => c.args))} during=${duringDisabled} result=${testResult}`,
  );

  // P10 — 네이티브 button, 비활성 아님, 포커스 가능
  const controls = IDS.flatMap((id) => ["[data-provider-enabled]", "[data-provider-diagnose]", "[data-provider-test]", "[data-cli-set]"].map((sel) => $(sel, rowOf(id)!)));
  const focusable = controls.every((b) => {
    if (!b || b.tagName !== "BUTTON" || b.getAttribute("type") !== "button" || (b as HTMLButtonElement).disabled || b.tabIndex < 0) return false;
    b.focus();
    return document.activeElement === b;
  });
  check("P10", "토글과 버튼은 네이티브 `<button type=\"button\">`이고 비활성이 아니며 포커스를 받을 수 있다", controls.length === 12 && focusable, `n=${controls.length} focusable=${focusable}`);

  // P07 — CLI 경로는 프로바이더 탭에, 에이전트 탭에는 빠른 액션만
  const inProvider = all("[data-cli-row]", $("[data-provider-settings]")!).length === 3 && !!$("[data-cli-refind]", $("[data-provider-settings]")!);
  await openSettingsTab("에이전트");
  const agentSection = $("[data-agent-settings]")!;
  const onlyActions = all("[data-qa-row]", agentSection).length > 0 && all("[data-cli-row]", agentSection).length === 0 && !$("[data-cli-refind]", agentSection);
  check("P07", "CLI 경로 지정·다시 찾기는 프로바이더 탭에 있고 에이전트 탭에는 빠른 액션만 있다", inProvider && onlyActions, `provider=${inProvider} agentTabOnlyActions=${onlyActions}`);

  // P08 — 모델이 저장돼 있어도 run_agent 인자는 네 개 키뿐
  (document.querySelector(".settings-close") as HTMLElement | null)?.click();
  await wait(200);
  const prompt8 = part("prompt") as HTMLTextAreaElement;
  prompt8.value = "다듬어 줘";
  prompt8.dispatchEvent(new Event("input", { bubbles: true }));
  await wait(100);
  const base8 = callsOf("run_agent").length;
  (part("send") as HTMLElement).click();
  await waitFor(() => callsOf("run_agent").length > base8, 3000);
  const runArgs = callsOf("run_agent")[callsOf("run_agent").length - 1]?.args ?? {};
  check("P08", "`run_agent` 인자의 키는 `path`·`preset`·`prompt`·`text` 네 개뿐이다", JSON.stringify(Object.keys(runArgs).sort()) === JSON.stringify(["path", "preset", "prompt", "text"]) && state.claude.model === "haiku", `keys=${Object.keys(runArgs).sort()} model=${state.claude.model}`);
}

void guard(main);

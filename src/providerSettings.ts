/**
 * 설정 창의 "프로바이더" 탭 — Claude Code·Codex·OpenCode 각각의 사용 여부·실행 파일 경로·모델과 상태 확인.
 * Paseo의 provider 설정(`enabled`·모델·진단)을 차용했다. `command`·`env`는 받지 않는다 — 설정 문자열이 곧 실행 명령이
 * 되면 웹뷰가 뚫렸을 때 임의 명령 실행이 된다(ADR 261022-230253). 경로·모델은 Rust가 다시 검증하고 저장한다.
 * 웹뷰는 `run_agent`에 모델도 경로도 넘기지 않는다 — Rust가 저장된 설정에서 읽는다.
 *
 * 화면 훅(`data-provider-*`·`data-cli-*`)은 하네스(harness/agent-settings.ts·agent-provider.ts)가 읽는다 — 이름을 바꾸면 검사가 깨진다.
 */
import { invoke } from "@tauri-apps/api/core";
import { AGENTS_CHANGED_EVENT, type DetectedAgent } from "./agentConfig";

interface Diagnostic {
  installed: boolean;
  path: string | null;
  version: string | null;
  error: string | null;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

export function createProviderSettings(): { section: HTMLElement; onShow(): void } {
  const section = el("section", "settings-agents settings-providers");
  section.dataset.providerSettings = "";

  const heading = el("h3", "settings-heading", "프로바이더");
  const hint = el(
    "p",
    "settings-switch-hint",
    "AI 에이전트로 쓸 CLI입니다. 로그인 셸의 PATH에서 찾고, 못 찾았거나 다른 것을 쓰려면 실행 파일의 절대 경로를 직접 지정하세요(파일 이름이 같아야 합니다). 모델을 비우면 CLI 자신의 설정을 따릅니다.",
  );
  const list = el("div", "cli-list");
  const refind = el("button", "qa-button", "다시 찾기");
  refind.type = "button";
  refind.dataset.cliRefind = "";
  const actions = el("div", "qa-actions");
  actions.append(refind);

  /** 행마다 마지막 확인 결과 — 목록을 다시 그려도 지워지지 않게 둔다. */
  const results = new Map<string, string>();

  /** 새 목록을 패널에도 알린다 — 같은 결과를 다시 묻지 않고 넘겨 준다. */
  const publish = (agents: DetectedAgent[]) =>
    window.dispatchEvent(new CustomEvent<DetectedAgent[]>(AGENTS_CHANGED_EVENT, { detail: agents }));

  const load = async (refresh: boolean): Promise<DetectedAgent[]> =>
    (await invoke<DetectedAgent[] | null>("detect_agents", refresh ? { refresh: true } : undefined).catch(() => null)) ?? [];

  /** 바뀐 설정을 반영해 목록을 다시 그리고 패널에 알린다. */
  const reload = async (): Promise<void> => {
    const agents = await load(false);
    render(agents);
    publish(agents);
  };

  function render(agents: DetectedAgent[]): void {
    list.replaceChildren(
      ...agents.map((agent) => {
        const row = el("div", "cli-row provider-row");
        row.dataset.cliRow = agent.id;
        row.dataset.providerRow = agent.id;

        const name = el("strong", "", agent.name);
        const path = el("span", "cli-path", agent.path ?? "없음");
        path.dataset.cliPath = "";

        const on = agent.enabled !== false;
        const toggle = el("button", "provider-switch");
        toggle.type = "button";
        toggle.setAttribute("role", "switch");
        toggle.setAttribute("aria-checked", String(on));
        toggle.setAttribute("aria-label", `${agent.name} 사용`);
        toggle.title = on ? "사용 중 — 누르면 끕니다" : "꺼짐 — 누르면 켭니다";
        toggle.dataset.providerEnabled = "";

        const error = el("p", "qa-error");
        error.dataset.providerError = "";
        error.hidden = true;
        const fail = (e: unknown) => {
          error.textContent = String(e);
          error.hidden = false;
        };

        toggle.addEventListener("click", async () => {
          error.hidden = true;
          try {
            await invoke("set_provider_settings", { preset: agent.id, enabled: toggle.getAttribute("aria-checked") !== "true" });
            await reload();
          } catch (e) {
            fail(e);
          }
        });

        const model = el("input", "provider-model");
        model.type = "text";
        model.value = agent.model ?? "";
        model.placeholder = "모델 (비우면 CLI 기본값)";
        model.setAttribute("aria-label", `${agent.name} 모델`);
        model.dataset.providerModel = "";
        model.addEventListener("change", async () => {
          error.hidden = true;
          try {
            await invoke("set_provider_settings", { preset: agent.id, model: model.value });
            await reload();
          } catch (e) {
            // 거부된 값은 저장되지 않았다 — 표시를 저장된 값으로 되돌린다.
            model.value = agent.model ?? "";
            fail(e);
          }
        });

        const input = el("input", "cli-input");
        input.type = "text";
        input.placeholder = "직접 지정할 실행 파일의 절대 경로 (비우면 지정 해제)";
        input.setAttribute("aria-label", `${agent.name} 실행 파일 경로`);
        input.dataset.cliInput = "";
        const set = el("button", "qa-button", "지정");
        set.type = "button";
        set.dataset.cliSet = "";
        const pathError = el("p", "qa-error");
        pathError.dataset.cliError = "";
        pathError.hidden = true;
        set.addEventListener("click", async () => {
          pathError.hidden = true;
          try {
            await invoke("set_agent_path", { preset: agent.id, path: input.value });
            input.value = "";
            await reload();
          } catch (e) {
            pathError.textContent = String(e);
            pathError.hidden = false;
          }
        });

        const result = el("span", "provider-result", results.get(agent.id) ?? "");
        result.dataset.providerResult = "";
        result.hidden = !results.get(agent.id);
        const show = (text: string) => {
          results.set(agent.id, text);
          result.textContent = text;
          result.hidden = !text;
        };

        const diagnose = el("button", "qa-button", "버전 확인");
        diagnose.type = "button";
        diagnose.dataset.providerDiagnose = "";
        diagnose.addEventListener("click", async () => {
          diagnose.disabled = true;
          try {
            const d = await invoke<Diagnostic>("provider_diagnostic", { preset: agent.id });
            show(d.version ? `버전: ${d.version}` : d.installed ? `확인하지 못함: ${d.error ?? ""}` : "설치되어 있지 않습니다");
          } catch (e) {
            show(String(e));
          } finally {
            diagnose.disabled = false;
          }
        });

        const test = el("button", "qa-button", "연결 시험");
        test.type = "button";
        test.title = "작은 문서를 실제로 한 번 고치게 해 봅니다(호출 비용이 듭니다)";
        test.dataset.providerTest = "";
        test.addEventListener("click", async () => {
          test.disabled = true;
          test.textContent = "시험 중…";
          show("");
          try {
            show(await invoke<string>("test_provider", { preset: agent.id }));
          } catch (e) {
            show(`실패: ${e}`);
          } finally {
            test.disabled = false;
            test.textContent = "연결 시험";
          }
        });

        const head = el("div", "provider-head");
        head.append(name, path, toggle);
        const check = el("div", "provider-check");
        check.append(diagnose, test, result);
        row.append(head, model, input, set, pathError, error, check);
        return row;
      }),
    );
  }

  refind.addEventListener("click", async () => {
    const agents = await load(true);
    render(agents);
    publish(agents);
  });

  section.append(heading, hint, list, actions);
  // 탭을 볼 때 처음 묻는다 — 설정을 열기만 해서는 탐색을 일으키지 않는다. Rust가 결과를 캐시해 두므로 다시 봐도 싸다.
  return { section, onShow: () => void load(false).then(render) };
}

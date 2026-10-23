/**
 * 설정 창의 "에이전트" 탭 — 빠른 액션 편집과 에이전트 CLI 경로.
 * 실행 파일 경로는 웹뷰가 아니라 Rust가 검증하고 저장한다(`set_agent_path`): 파일명이 프리셋 이름과 같은 실행 파일만 받는다.
 *
 * 화면 훅(`data-qa-*`·`data-cli-*`)은 하네스(harness/agent-settings.ts)가 읽는다 — 이름을 바꾸면 검사가 깨진다.
 */
import { invoke } from "@tauri-apps/api/core";
import {
  AGENTS_CHANGED_EVENT,
  isValidQuickActions,
  readQuickActions,
  resetQuickActions,
  saveQuickActions,
  type DetectedAgent,
  type QuickAction,
} from "./agentConfig";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

export function createAgentSettings(): { section: HTMLElement; onShow(): void } {
  const section = el("section", "settings-agents");
  section.dataset.agentSettings = "";

  // --- 빠른 액션 ---
  const qaHeading = el("h3", "settings-heading", "빠른 액션");
  const qaHint = el("p", "settings-switch-hint", "에이전트 패널의 칩 하나가 지시문 하나입니다. 칩을 누르면 지시 입력창이 이 문장으로 채워집니다.");
  const qaList = el("div", "qa-list");
  qaList.dataset.qaList = "";
  const qaError = el("p", "qa-error", "이름과 문장을 모두 채워야 저장됩니다.");
  qaError.dataset.qaError = "";
  qaError.hidden = true;
  const qaAdd = el("button", "qa-button", "추가");
  qaAdd.type = "button";
  qaAdd.dataset.qaAdd = "";
  const qaReset = el("button", "qa-button", "기본값으로 복원");
  qaReset.type = "button";
  qaReset.dataset.qaReset = "";
  const qaActions = el("div", "qa-actions");
  qaActions.append(qaAdd, qaReset);

  let list: QuickAction[] = readQuickActions();

  /** 저장한다. 비어 있는 칸이 있으면 저장하지 않고 이유를 보인다(저장된 목록과 패널은 그대로). */
  const commit = (): void => {
    const ok = isValidQuickActions(list) && saveQuickActions(list);
    qaError.hidden = ok;
  };

  const renderRows = (): void => {
    qaList.replaceChildren(
      ...list.map((action, index) => {
        const row = el("div", "qa-row");
        row.dataset.qaRow = "";
        const name = el("input", "qa-name");
        name.type = "text";
        name.value = action.name;
        name.placeholder = "이름";
        name.setAttribute("aria-label", "빠른 액션 이름");
        name.dataset.qaName = "";
        name.addEventListener("change", () => {
          list[index].name = name.value;
          commit();
        });
        const text = el("textarea", "qa-text");
        text.rows = 2;
        text.value = action.text;
        text.placeholder = "에이전트에 보낼 지시문";
        text.setAttribute("aria-label", "빠른 액션 지시문");
        text.dataset.qaText = "";
        text.addEventListener("change", () => {
          list[index].text = text.value;
          commit();
        });
        const remove = el("button", "qa-button", "삭제");
        remove.type = "button";
        remove.setAttribute("aria-label", `${action.name || "이 액션"} 삭제`);
        remove.dataset.qaDelete = "";
        remove.addEventListener("click", () => {
          list.splice(index, 1);
          commit();
          renderRows();
        });
        row.append(name, text, remove);
        return row;
      }),
    );
  };

  qaAdd.addEventListener("click", () => {
    list.push({ name: "새 액션", text: "여기에 지시문을 쓰세요." });
    commit();
    renderRows();
  });
  qaReset.addEventListener("click", () => {
    resetQuickActions();
    list = readQuickActions();
    qaError.hidden = true;
    renderRows();
  });
  renderRows();

  // --- CLI 경로 ---
  const cliHeading = el("h3", "settings-heading", "에이전트 CLI");
  const cliHint = el("p", "settings-switch-hint", "로그인 셸의 PATH에서 찾습니다. 못 찾았거나 다른 것을 쓰려면 실행 파일의 절대 경로를 직접 지정하세요(파일 이름이 같아야 합니다).");
  const cliList = el("div", "cli-list");
  const refind = el("button", "qa-button", "다시 찾기");
  refind.type = "button";
  refind.dataset.cliRefind = "";
  const cliActions = el("div", "qa-actions");
  cliActions.append(refind);

  /** 탐색 결과를 패널에도 알린다 — 같은 결과를 다시 묻지 않고 넘겨 준다. */
  const publish = (agents: DetectedAgent[]) =>
    window.dispatchEvent(new CustomEvent<DetectedAgent[]>(AGENTS_CHANGED_EVENT, { detail: agents }));

  const renderCli = (agents: DetectedAgent[]): void => {
    cliList.replaceChildren(
      ...agents.map((agent) => {
        const row = el("div", "cli-row");
        row.dataset.cliRow = agent.id;
        const name = el("strong", "", agent.name);
        const path = el("span", "cli-path", agent.path ?? "없음");
        path.dataset.cliPath = "";
        const input = el("input", "cli-input");
        input.type = "text";
        input.placeholder = "직접 지정할 실행 파일의 절대 경로 (비우면 지정 해제)";
        input.setAttribute("aria-label", `${agent.name} 실행 파일 경로`);
        input.dataset.cliInput = "";
        const set = el("button", "qa-button", "지정");
        set.type = "button";
        set.dataset.cliSet = "";
        const error = el("p", "qa-error");
        error.dataset.cliError = "";
        error.hidden = true;
        set.addEventListener("click", async () => {
          error.hidden = true;
          try {
            await invoke("set_agent_path", { preset: agent.id, path: input.value });
            const next = (await invoke<DetectedAgent[] | null>("detect_agents")) ?? [];
            input.value = "";
            renderCli(next);
            publish(next);
          } catch (e) {
            error.textContent = String(e);
            error.hidden = false;
          }
        });
        row.append(name, path, input, set, error);
        return row;
      }),
    );
  };

  const detect = async (refresh: boolean): Promise<void> => {
    const agents = (await invoke<DetectedAgent[] | null>("detect_agents", refresh ? { refresh: true } : undefined).catch(() => null)) ?? [];
    renderCli(agents);
    if (refresh) publish(agents);
  };
  refind.addEventListener("click", () => void detect(true));

  section.append(qaHeading, qaHint, qaList, qaError, qaActions, cliHeading, cliHint, cliList, cliActions);
  // 탭을 볼 때 처음 묻는다 — 설정을 열기만 해서는 탐색을 일으키지 않는다. Rust가 결과를 캐시해 두므로 다시 봐도 싸다.
  return { section, onShow: () => void detect(false) };
}

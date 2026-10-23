/**
 * 설정 창의 "에이전트" 탭 — 빠른 액션 편집. 프로바이더(CLI) 설정은 "프로바이더" 탭(providerSettings.ts)에 있다.
 *
 * 화면 훅(`data-qa-*`)은 하네스(harness/agent-settings.ts)가 읽는다 — 이름을 바꾸면 검사가 깨진다.
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

  // --- 사용할 수 있는 프로바이더 — 경로·모델·켜고 끄기는 "프로바이더" 탭에서 한다. ---
  const status = el("p", "settings-switch-hint agent-status");
  status.dataset.agentStatus = "";
  const showStatus = (agents: DetectedAgent[]): void => {
    const usable = agents.filter((a) => a.path !== null && a.enabled !== false).map((a) => a.name);
    status.textContent = usable.length
      ? `지금 쓸 수 있는 프로바이더: ${usable.join(", ")}`
      : "지금 쓸 수 있는 프로바이더가 없습니다 — 설정의 '프로바이더' 탭에서 확인하세요.";
  };
  window.addEventListener(AGENTS_CHANGED_EVENT, (event) => showStatus((event as CustomEvent<DetectedAgent[]>).detail));

  section.append(status, qaHeading, qaHint, qaList, qaError, qaActions);
  // 탭을 볼 때 처음 묻는다 — 설정을 열기만 해서는 탐색을 일으키지 않는다. Rust가 결과를 캐시해 두므로 다시 봐도 싸다.
  return {
    section,
    onShow: () =>
      void invoke<DetectedAgent[] | null>("detect_agents")
        .catch(() => null)
        .then((agents) => showStatus(agents ?? [])),
  };
}

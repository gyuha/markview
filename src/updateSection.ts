/**
 * 설정 창의 "업데이트" 항목 — 현재 버전을 보여 주고, 확인 → (새 버전이 있으면) 내려받기·설치·다시 시작.
 * 확인·설치는 Rust 커맨드(`check_update`·`install_update`)가 하고 진행은 `update-progress` 이벤트로 온다.
 * 웹뷰에는 updater 권한이 없다(ADR 261010-234732). 시작할 때나 설정을 열 때 네트워크 확인은 하지 않는다 —
 * 사용자가 "업데이트 확인"을 눌렀을 때만 확인한다.
 *
 * 화면 훅(`data-update*`)은 하네스(harness/update-*.ts)가 읽는다 — 이름을 바꾸면 검사가 깨진다.
 */
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { confirmDialog } from "./modal";

type State = "idle" | "checking" | "up-to-date" | "available" | "downloading" | "installed" | "error";

interface UpdateInfo {
  version: string;
  notes: string;
  date?: string | null;
}

interface Progress {
  downloaded: number;
  total: number | null;
}

export interface UpdateHost {
  /** 저장하지 않은 문서가 있는지 — 다시 시작하면 사라지므로 설치 전에 확인한다. */
  hasUnsavedDocs(): boolean;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function createUpdateSection(host: UpdateHost): { section: HTMLElement; dispose(): void } {
  const section = el("section", "settings-update");
  section.dataset.update = "";

  const heading = el("h3", "settings-heading", "업데이트");

  const versionRow = el("div", "settings-update-row");
  const versionLabel = el("span", "settings-update-label", "현재 버전");
  const version = el("span", "settings-update-version", "…");
  version.dataset.updateVersion = "";
  versionRow.append(versionLabel, version);

  const status = el("p", "settings-update-status");
  status.setAttribute("role", "status");
  const notes = el("pre", "settings-update-notes");
  notes.dataset.updateNotes = "";
  const progress = el("div", "settings-update-progress");
  progress.dataset.updateProgress = "";
  const error = el("p", "settings-update-error");
  error.dataset.updateError = "";
  error.setAttribute("role", "alert");

  const actions = el("div", "settings-update-actions");
  const check = el("button", "settings-update-button", "업데이트 확인");
  check.type = "button";
  check.dataset.updateCheck = "";
  const install = el("button", "settings-update-button settings-update-install", "업데이트");
  install.type = "button";
  install.dataset.updateInstall = "";
  actions.append(check, install);

  section.append(heading, versionRow, status, notes, progress, error, actions);

  let state: State = "idle";
  let found: UpdateInfo | null = null;
  let unlisten: UnlistenFn | null = null;
  let disposed = false;

  const render = (message = "") => {
    section.dataset.updateState = state;
    check.disabled = state === "checking" || state === "downloading";
    install.disabled = state !== "available";
    install.hidden = state !== "available";
    notes.hidden = !(state === "available" && !!found?.notes);
    progress.hidden = state !== "downloading";
    error.hidden = state !== "error";
    if (state === "error") error.textContent = message;
    status.textContent = {
      idle: "",
      checking: "업데이트를 확인하는 중…",
      "up-to-date": "최신 버전입니다.",
      available: found ? `새 버전 ${found.version}을 사용할 수 있습니다.` : "",
      downloading: "내려받아 설치하는 중…",
      installed: "설치했습니다. 앱을 다시 시작합니다.",
      error: "",
    }[state];
    notes.textContent = found?.notes ?? "";
  };
  const set = (next: State, message?: string) => {
    if (disposed) return;
    state = next;
    render(message);
  };

  const stopListening = () => {
    // 해제가 실패해도(이미 닫힘 등) 화면에 오류가 번지지 않게 한다.
    try {
      const done: unknown = unlisten?.();
      if (done instanceof Promise) done.catch(() => {});
    } catch {}
    unlisten = null;
  };

  check.addEventListener("click", async () => {
    if (state === "checking" || state === "downloading") return;
    set("checking");
    try {
      found = await invoke<UpdateInfo | null>("check_update");
      set(found ? "available" : "up-to-date");
    } catch (e) {
      found = null;
      set("error", `업데이트를 확인하지 못했습니다: ${e}`);
    }
  });

  install.addEventListener("click", async () => {
    if (state !== "available") return;
    // 다시 시작하면 저장하지 않은 문서가 사라진다 — 먼저 묻는다. 대화상자가 떠 있는 동안 중복 클릭은 막는다.
    install.disabled = true;
    if (
      host.hasUnsavedDocs() &&
      !(await confirmDialog({
        message: "저장하지 않은 변경이 있습니다.\n업데이트하면 앱이 다시 시작되고 저장하지 않은 내용이 사라집니다.",
        confirmLabel: "업데이트하고 다시 시작",
      }))
    ) {
      render();
      return;
    }
    set("downloading");
    progress.textContent = "0%";
    try {
      unlisten = await listen<Progress>("update-progress", ({ payload }) => {
        if (disposed || state !== "downloading") return;
        progress.textContent = payload.total
          ? `${Math.min(100, Math.round((payload.downloaded / payload.total) * 100))}%`
          : megabytes(payload.downloaded);
      });
      // 구독을 기다리는 사이에 창이 닫혔다면 등록이 끝나는 즉시 푼다.
      if (disposed) stopListening();
      await invoke("install_update");
      set("installed");
    } catch (e) {
      set("error", `업데이트하지 못했습니다: ${e}`);
    } finally {
      stopListening();
    }
  });

  getVersion().then(
    (v) => {
      if (!disposed) version.textContent = v;
    },
    () => {
      if (!disposed) version.textContent = "알 수 없음";
    },
  );
  render();

  return {
    section,
    dispose() {
      disposed = true;
      stopListening();
    },
  };
}

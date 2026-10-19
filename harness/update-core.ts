// 설정 창의 업데이트 항목(V01–V09). `node harness/run.mjs update`가 Chromium·WebKit에서 돌린다.
// 모킹 IPC의 응답(`check_update`·`install_update`·`plugin:app|version`)과 `update-progress` 이벤트는 검사가 직접
// 정하고, 검사마다 설정 창을 새로 열어 자기 상태에서 시작한다(앞 검사가 남긴 상태에 기대지 않는다).
// 기대값은 화면을 만드는 코드가 아니라 검사가 정한 상수(1.2.3·9.9.9·25%…)와 비교한다.
import {
  activeTab,
  calls,
  check,
  emitTauri,
  eq,
  guard,
  injectViaSplit,
  ready,
  visible,
  wait,
  waitFor,
} from "./lib-muya";

const pageErrors: string[] = [];
window.addEventListener("error", (e) => void pageErrors.push(String(e.message)));
window.addEventListener("unhandledrejection", (e) => void pageErrors.push(String(e.reason)));

const count = (cmd: string) => calls().filter((c) => c.cmd === cmd).length;

// 명령마다 응답을 "덮어쓴다". lib-muya의 respond는 겹쳐 걸면 먼저 건 응답(거부 포함)이 뒤의 응답을 가려서,
// 응답을 바꿔 가며 보는 이 하네스에는 맞지 않는다. 호출 기록은 원래 모킹이 남기므로 그대로 쓴다.
// Tauri의 unlisten은 이 전역을 먼저 부른다. 모킹 환경에는 없어서 비워 둔 것을 채운다(실제 앱에는 있다).
(window as unknown as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__ ??= { unregisterListener() {} };

const replies = new Map<string, (args?: Record<string, unknown>) => unknown>();
{
  const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a?: Record<string, unknown>) => Promise<unknown> } })
    .__TAURI_INTERNALS__;
  const original = internals.invoke;
  internals.invoke = async (c, a) => {
    const recorded = await original(c, a);
    const reply = replies.get(c);
    return reply ? reply(a) : recorded;
  };
}
const respond = (cmd: string, reply: (args?: Record<string, unknown>) => unknown) => void replies.set(cmd, reply);

/** 미룬 응답. 검사가 풀어 줄 때까지 IPC가 끝나지 않는다(확인 중·설치 중 상태를 붙잡아 둔다). */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const root = () => document.querySelector<HTMLElement>("[data-update]");
const part = (selector: string) => root()?.querySelector<HTMLElement>(selector) ?? null;
const state = () => root()?.dataset.updateState ?? null;
const text = () => root()?.textContent ?? "";

const pressEsc = () =>
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));

/** 열려 있는 설정 창을 닫는다. */
async function closeSettings(): Promise<void> {
  for (let i = 0; i < 3 && document.querySelector(".modal.settings"); i++) {
    pressEsc();
    await wait(30);
  }
}

/** 설정 창을 새로 열고 모든 탭을 눌러 보며 업데이트 항목이 보이는 탭을 찾는다. */
async function openUpdate(): Promise<boolean> {
  await closeSettings();
  document.querySelector<HTMLElement>("#settings-button")!.click();
  await waitFor(() => document.querySelector(".modal.settings"));
  for (const tab of document.querySelectorAll<HTMLElement>(".modal.settings [role=tab]")) {
    tab.click();
    await wait(20);
    if (visible(root())) return true;
  }
  return visible(root());
}

/** 확인 대화상자(설정 창이 아닌 `.modal`). */
const confirmBox = () => [...document.querySelectorAll<HTMLElement>(".modal-backdrop .modal")].find((m) => !m.classList.contains("settings")) ?? null;

const click = (selector: string) => part(selector)?.click();
const check_ = async () => {
  click("[data-update-check]");
  await wait(60);
};

await guard(async () => {
  if (!(await ready())) return check("", "탭이 열렸다", false);
  respond("plugin:app|version", () => "1.2.3");
  respond("write_markdown", () => ({ conflict: false, mtime_ms: 2 }));

  // ── V08 시작·열기·탭 전환만으로는 확인하지 않는다 ───────────────────────────
  await wait(800);
  const opened = await openUpdate();
  for (const tab of document.querySelectorAll<HTMLElement>(".modal.settings [role=tab]")) {
    tab.click();
    await wait(20);
  }
  check(
    "V08",
    "시작하고 기다리고 설정 창을 열어 모든 탭을 오가도 check_update·install_update가 불리지 않는다",
    opened && count("check_update") === 0 && count("install_update") === 0,
    `opened=${opened} check=${count("check_update")} install=${count("install_update")}`,
  );

  // ── V01 업데이트 항목과 현재 버전 ───────────────────────────────────────────
  await openUpdate();
  await waitFor(() => part("[data-update-version]")?.textContent === "1.2.3");
  const checkButton = part("[data-update-check]");
  eq(
    "V01",
    "업데이트 항목에 현재 버전(1.2.3)과 보이는 확인 버튼이 있고 상태는 idle이다",
    {
      shown: visible(root()),
      version: part("[data-update-version]")?.textContent,
      versionShown: visible(part("[data-update-version]")),
      checkShown: visible(checkButton),
      enabled: checkButton ? !(checkButton as HTMLButtonElement).disabled : null,
      state: state(),
      checks: count("check_update"),
    },
    { shown: true, version: "1.2.3", versionShown: true, checkShown: true, enabled: true, state: "idle", checks: 0 },
  );

  // ── V02 새 버전 없음 ────────────────────────────────────────────────────────
  respond("check_update", () => null);
  await openUpdate();
  const before02 = count("check_update");
  await check_();
  await waitFor(() => state() === "up-to-date");
  eq(
    "V02",
    "새 버전이 없으면(null) check_update 1번 · up-to-date · \"최신\" 안내 · 설치 버튼 숨김",
    {
      checks: count("check_update") - before02,
      state: state(),
      saysLatest: text().includes("최신"),
      installShown: visible(part("[data-update-install]")),
    },
    { checks: 1, state: "up-to-date", saysLatest: true, installShown: false },
  );

  // ── V03 새 버전 있음 ────────────────────────────────────────────────────────
  respond("check_update", () => ({ version: "9.9.9", notes: "고친 것 하나\n고친 것 둘" }));
  await openUpdate();
  await check_();
  await waitFor(() => state() === "available");
  eq(
    "V03",
    "새 버전 응답이면 available · 9.9.9와 노트가 보이고 설치 버튼이 보인다",
    {
      state: state(),
      version: text().includes("9.9.9"),
      notes: visible(part("[data-update-notes]")) && (part("[data-update-notes]")?.textContent ?? "").includes("고친 것 둘"),
      installShown: visible(part("[data-update-install]")),
    },
    { state: "available", version: true, notes: true, installShown: true },
  );

  // ── V04 설치와 진행률 ───────────────────────────────────────────────────────
  {
    const install = deferred<null>();
    respond("install_update", () => install.promise);
    await openUpdate();
    await check_();
    await waitFor(() => state() === "available");
    const before = count("install_update");
    click("[data-update-install]");
    await waitFor(() => state() === "downloading");
    // 앱이 update-progress를 듣기 시작할 때까지 기다린 뒤 이벤트를 보낸다.
    await waitFor(() => calls().some((c) => c.cmd === "plugin:event|listen" && c.args?.event === "update-progress"));
    const seen: (string | undefined)[] = [];
    for (const downloaded of [25, 50, 100]) {
      emitTauri("update-progress", { downloaded, total: 100 });
      await wait(40);
      seen.push(part("[data-update-progress]")?.textContent?.trim());
    }
    const downloadingState = state();
    install.resolve(null);
    await waitFor(() => state() === "installed");
    eq(
      "V04",
      "설치 → install_update 1번 · 진행률 25%→50%→100% · 끝나면 installed와 재시작 안내",
      {
        installs: count("install_update") - before,
        downloadingState,
        seen,
        state: state(),
        restartNote: text().includes("다시 시작"),
      },
      { installs: 1, downloadingState: "downloading", seen: ["25%", "50%", "100%"], state: "installed", restartNote: true },
    );
  }

  // ── V05 오류 ────────────────────────────────────────────────────────────────
  {
    pageErrors.length = 0;
    respond("check_update", () => Promise.reject("network down"));
    await openUpdate();
    await check_();
    await waitFor(() => state() === "error");
    const checkError = {
      state: state(),
      message: visible(part("[data-update-error]")) && (part("[data-update-error]")?.textContent ?? "").includes("network down"),
      retry: !(part("[data-update-check]") as HTMLButtonElement | null)?.disabled,
    };
    respond("check_update", () => ({ version: "9.9.9", notes: "n" }));
    respond("install_update", () => Promise.reject("disk full"));
    await openUpdate();
    await check_();
    await waitFor(() => state() === "available");
    click("[data-update-install]");
    await waitFor(() => state() === "error");
    const installError = {
      state: state(),
      message: visible(part("[data-update-error]")) && (part("[data-update-error]")?.textContent ?? "").includes("disk full"),
      retry: !(part("[data-update-check]") as HTMLButtonElement | null)?.disabled,
    };
    await wait(50);
    eq(
      "V05",
      "확인·설치가 거부되면 error · 오류 내용이 보이고 확인 버튼이 다시 눌린다 · 페이지 오류 0",
      { checkError, installError, pageErrors },
      {
        checkError: { state: "error", message: true, retry: true },
        installError: { state: "error", message: true, retry: true },
        pageErrors: [],
      },
    );
  }

  // ── V06 연타 ────────────────────────────────────────────────────────────────
  {
    const slowCheck = deferred<{ version: string; notes: string }>();
    const slowInstall = deferred<null>();
    respond("check_update", () => slowCheck.promise);
    respond("install_update", () => slowInstall.promise);
    await openUpdate();
    const checksBefore = count("check_update");
    const installsBefore = count("install_update");
    click("[data-update-check]");
    await waitFor(() => state() === "checking");
    const checkDisabled = !!(part("[data-update-check]") as HTMLButtonElement | null)?.disabled;
    click("[data-update-check]");
    click("[data-update-check]");
    await wait(40);
    slowCheck.resolve({ version: "9.9.9", notes: "n" });
    await waitFor(() => state() === "available");
    click("[data-update-install]");
    await waitFor(() => state() === "downloading");
    const installButton = part("[data-update-install]") as HTMLButtonElement | null;
    const installBlocked = !installButton || installButton.disabled || !visible(installButton);
    click("[data-update-install]");
    click("[data-update-install]");
    await wait(40);
    slowInstall.resolve(null);
    await waitFor(() => state() === "installed");
    eq(
      "V06",
      "확인 중·설치 중에는 버튼이 막혀 연타해도 check_update 1번 · install_update 1번",
      {
        checkDisabled,
        installBlocked,
        checks: count("check_update") - checksBefore,
        installs: count("install_update") - installsBefore,
      },
      { checkDisabled: true, installBlocked: true, checks: 1, installs: 1 },
    );
  }

  // ── V07 저장하지 않은 문서 ──────────────────────────────────────────────────
  {
    const tab = activeTab()!;
    respond("check_update", () => ({ version: "9.9.9", notes: "n" }));
    respond("install_update", () => null);
    // 수정됨 탭을 만든다(분할 모드에서 원문을 바꿔 넣는다).
    injectViaSplit("저장하지 않은 내용\n");
    await waitFor(() => tab.dirty);
    await openUpdate();
    await check_();
    await waitFor(() => state() === "available");
    const before = count("install_update");
    click("[data-update-install]");
    const dialog = await waitFor(() => confirmBox(), 2000);
    const whileOpen = count("install_update") - before;
    dialog?.querySelector<HTMLElement>(".modal-cancel")?.click();
    await wait(80);
    const afterCancel = count("install_update") - before;
    const stillAvailable = state() === "available";
    click("[data-update-install]");
    const dialog2 = await waitFor(() => confirmBox(), 2000);
    dialog2?.querySelector<HTMLElement>(".modal-confirm")?.click();
    await waitFor(() => count("install_update") - before === 1, 2000);
    const afterConfirm = count("install_update") - before;

    // 수정된 탭이 없으면 대화상자 없이 바로 설치한다.
    emitTauri("save");
    await waitFor(() => !tab.dirty, 3000);
    await openUpdate();
    await check_();
    await waitFor(() => state() === "available");
    const cleanBefore = count("install_update");
    click("[data-update-install]");
    await wait(150);
    const cleanDialog = !!confirmBox();
    const cleanInstalls = count("install_update") - cleanBefore;

    eq(
      "V07",
      "수정됨 탭이 있으면 설치 전에 확인 대화상자(그동안 0번, 취소 0번, 확인 1번), 없으면 바로 1번",
      { hadDialog: !!dialog, whileOpen, afterCancel, stillAvailable, hadDialog2: !!dialog2, afterConfirm, cleanDialog, cleanInstalls },
      { hadDialog: true, whileOpen: 0, afterCancel: 0, stillAvailable: true, hadDialog2: true, afterConfirm: 1, cleanDialog: false, cleanInstalls: 1 },
    );
  }

  // ── V09 닫은 뒤의 이벤트 ────────────────────────────────────────────────────
  {
    pageErrors.length = 0;
    // 진행 구독 등록이 끝나기 전에 창을 닫는 경쟁: 등록이 끝나는 즉시 풀려야 한다(설치가 끝날 때까지 남지 않는다).
    const lateListen = deferred<number>();
    const lateInstall = deferred<null>();
    respond("check_update", () => ({ version: "9.9.9", notes: "n" }));
    respond("install_update", () => lateInstall.promise);
    respond("plugin:event|listen", () => lateListen.promise);
    await openUpdate();
    await check_();
    await waitFor(() => state() === "available");
    const listensBefore = calls().filter((c) => c.cmd === "plugin:event|listen" && c.args?.event === "update-progress").length;
    const unlistenRaceBefore = count("plugin:event|unlisten");
    click("[data-update-install]");
    await waitFor(() => calls().filter((c) => c.cmd === "plugin:event|listen" && c.args?.event === "update-progress").length > listensBefore);
    await closeSettings();
    lateListen.resolve(7);
    await waitFor(() => count("plugin:event|unlisten") > unlistenRaceBefore, 1500);
    const lateReleased = count("plugin:event|unlisten") - unlistenRaceBefore;
    replies.delete("plugin:event|listen");
    lateInstall.resolve(null);
    await wait(60);
    pageErrors.length = 0;
    const slowInstall = deferred<null>();
    respond("check_update", () => ({ version: "9.9.9", notes: "n" }));
    respond("install_update", () => slowInstall.promise);
    await openUpdate();
    await check_();
    await waitFor(() => state() === "available");
    const installsBefore = count("install_update");
    click("[data-update-install]");
    await waitFor(() => state() === "downloading");
    // 진행 구독 등록이 끝나고 설치 호출이 시작된 뒤에 닫는다.
    await waitFor(() => count("install_update") > installsBefore);
    const unlistenBefore = count("plugin:event|unlisten");
    await closeSettings();
    // 설치가 아직 끝나지 않았는데 창을 닫으면, 닫는 순간 진행 구독이 풀려야 한다(끝날 때까지 남지 않는다).
    const unlistenedAtClose = count("plugin:event|unlisten") - unlistenBefore;
    emitTauri("update-progress", { downloaded: 40, total: 100 });
    slowInstall.resolve(null);
    await wait(100);
    const closedClean = !document.querySelector(".modal.settings") && pageErrors.length === 0;
    const reopened = await openUpdate();
    await waitFor(() => part("[data-update-version]")?.textContent === "1.2.3");
    eq(
      "V09",
      "설치 중에 Esc로 닫으면 진행 구독이 그 자리에서 풀리고, 이후 update-progress가 와도 페이지 오류가 없으며, 다시 열면 업데이트 항목·버전·확인 버튼이 다시 있다",
      {
        lateReleased,
        closedClean,
        unlistenedAtClose,
        reopened,
        version: part("[data-update-version]")?.textContent,
        checkShown: visible(part("[data-update-check]")),
        state: state(),
        pageErrors,
      },
      { lateReleased: 1, closedClean: true, unlistenedAtClose: 1, reopened: true, version: "1.2.3", checkShown: true, state: "idle", pageErrors: [] },
    );
    await closeSettings();
  }
});

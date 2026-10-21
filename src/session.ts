/**
 * 세션(앱을 껐을 때 열려 있던 탭의 경로·순서·활성 탭)과 "시작 시 복원" 토글. 둘 다 localStorage에 둔다.
 * 최근 파일(recent.ts)과는 별개다 — 최근 파일은 닫은 파일도 남는 기록이고 세션은 지금 열린 탭이다.
 */
const SESSION_KEY = "markview.session";
const RESTORE_KEY = "markview.restoreSession";

export interface Session {
  paths: string[];
  active: string | null;
}

/** 창 라벨 → 그 창의 세션. 옛 형식(단일 {paths, active})은 main 창의 것으로 읽는다. */
type WindowSessions = Record<string, Session>;

const MAIN_LABEL = "main";
const EMPTY: Session = { paths: [], active: null };

function parseEntry(value: unknown): Session {
  if (typeof value !== "object" || value === null) return { ...EMPTY, paths: [] };
  const { paths, active } = value as { paths?: unknown; active?: unknown };
  return {
    paths: Array.isArray(paths) ? paths.filter((p): p is string => typeof p === "string") : [],
    active: typeof active === "string" ? active : null,
  };
}

function readAll(): WindowSessions {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SESSION_KEY) ?? "null");
    if (typeof parsed !== "object" || parsed === null) return {};
    const { windows } = parsed as { windows?: unknown };
    if (typeof windows === "object" && windows !== null) {
      const result: WindowSessions = {};
      for (const [label, entry] of Object.entries(windows)) result[label] = parseEntry(entry);
      return result;
    }
    // 옛 단일 값 — 창이 하나뿐이던 시절의 기록이므로 main 창의 세션이다.
    return { [MAIN_LABEL]: parseEntry(parsed) };
  } catch {
    return {};
  }
}

function writeAll(windows: WindowSessions): void {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ windows }));
  } catch {
    // 저장소를 못 쓰면 다음 실행에서 복원할 것이 없을 뿐이다.
  }
}

export function readSession(label: string = MAIN_LABEL): Session {
  const entry = readAll()[label];
  return entry ? { paths: [...entry.paths], active: entry.active } : { paths: [], active: null };
}

/** 이 창의 항목만 갱신한다 — 다른 창의 항목은 그대로 둔다. */
export function saveSession(label: string, paths: string[], active: string | null): void {
  writeAll({ ...readAll(), [label]: { paths, active } });
}

/** 이 창의 항목을 지운다 — 직접 닫은 창은 다음 실행에서 복원하지 않는다. 다른 창 항목은 그대로다. */
export function removeSession(label: string): void {
  const windows = readAll();
  delete windows[label];
  writeAll(windows);
}

/** 모든 창의 항목을 지운다 — 마지막 창을 직접 닫았으면 다음 실행에서 복원할 창이 없다. */
export function removeAllSessions(): void {
  writeAll({});
}

/**
 * 마지막 창을 닫을 때 쓴다 — 그 창의 탭만 main 항목으로 남기고 나머지 창 항목은 모두 지운다.
 * 다음 실행은 main 창 하나로 마지막에 닫은 창의 탭을 되살리고, 먼저 닫은 창은 되살리지 않는다.
 */
export function keepLastWindowAsMain(label: string): void {
  const entry = readAll()[label];
  writeAll(entry && entry.paths.length > 0 ? { [MAIN_LABEL]: entry } : {});
}

/** 되살릴 창 — main 아닌 항목 중 열 탭이 있는 것. 시작 경로는 활성 탭(없으면 첫 탭)이다. */
export function readOtherWindows(): { label: string; path: string }[] {
  return Object.entries(readAll())
    .filter(([label, s]) => label !== MAIN_LABEL && s.paths.length > 0)
    .map(([label, s]) => ({ label, path: s.active && s.paths.includes(s.active) ? s.active : s.paths[0] }));
}

/** 저장된 값이 없으면 켬이다 — 토글은 복원 여부만 정하고 기록은 항상 한다. */
export function readRestoreSession(): boolean {
  try {
    return localStorage.getItem(RESTORE_KEY) !== "false";
  } catch {
    return true;
  }
}

export function saveRestoreSession(on: boolean): void {
  try {
    localStorage.setItem(RESTORE_KEY, String(on));
  } catch {
    // 저장소를 못 쓰면 이번 실행 동안만 기본값(켬)으로 본다.
  }
}

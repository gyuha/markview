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

export function readSession(): Session {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SESSION_KEY) ?? "null");
    if (typeof parsed !== "object" || parsed === null) return { paths: [], active: null };
    const { paths, active } = parsed as { paths?: unknown; active?: unknown };
    return {
      paths: Array.isArray(paths) ? paths.filter((p): p is string => typeof p === "string") : [],
      active: typeof active === "string" ? active : null,
    };
  } catch {
    return { paths: [], active: null };
  }
}

export function saveSession(paths: string[], active: string | null): void {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ paths, active }));
  } catch {
    // 저장소를 못 쓰면 다음 실행에서 복원할 것이 없을 뿐이다.
  }
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

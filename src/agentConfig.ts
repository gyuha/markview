/**
 * AI 에이전트 설정 — 빠른 액션 목록과 "에이전트 목록이 바뀌었다"는 알림.
 * 빠른 액션은 에이전트에 보낼 문장(이름 + 지시문)이다. 실행할 명령이 아니므로 사용자가 고쳐도 보안 문제가 없다(ADR 261022-230253).
 * 목록은 localStorage에 둔다(다른 설정과 같다). 패널(지연 로드)과 설정 창이 함께 쓰므로 가볍게 둔다.
 */

export interface QuickAction {
  name: string;
  text: string;
}

/** `detect_agents`가 돌려주는 프리셋 하나. 못 찾았으면 `path`가 null이다. */
export interface DetectedAgent {
  id: string;
  name: string;
  path: string | null;
}

/** 처음 쓸 때와 "기본값으로 복원"할 때의 목록. */
export const DEFAULT_QUICK_ACTIONS: readonly QuickAction[] = [
  { name: "번역", text: "이 글을 영어로 번역해 줘. 마크다운 서식과 코드 블록은 그대로 유지해 줘." },
  { name: "요약", text: "이 글의 핵심을 세 문장 안으로 요약해서 맨 위에 '## 요약' 섹션으로 넣어 줘. 나머지 본문은 바꾸지 마." },
  { name: "맞춤법·문장 다듬기", text: "맞춤법과 띄어쓰기를 바로잡고 어색한 문장을 자연스럽게 다듬어 줘. 내용과 마크다운 서식은 바꾸지 마." },
  { name: "목차 생성", text: "제목 구조를 바탕으로 맨 위에 목차를 만들어 줘. 각 항목은 해당 제목으로 이동하는 링크로 해 줘. 다른 본문은 바꾸지 마." },
];

const KEY = "markview.agent.actions";

/** 같은 창 안에서 목록이 바뀌었다(localStorage의 storage 이벤트는 다른 창에만 온다). */
export const QUICK_ACTIONS_EVENT = "markview-quick-actions";
/** 에이전트 탐색 결과가 바뀌었다(다시 찾기·수동 경로). `detail`에 새 목록이 실린다. */
export const AGENTS_CHANGED_EVENT = "markview-agents-changed";

export const isQuickActionsStorageKey = (key: string | null) => key === KEY;

const copyDefaults = () => DEFAULT_QUICK_ACTIONS.map((a) => ({ ...a }));

/** 저장된 목록. 저장한 적이 없거나 깨졌으면 기본값이고, 모두 지워 저장한 빈 목록은 빈 채로 돌려준다. */
export function readQuickActions(): QuickAction[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return copyDefaults();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return copyDefaults();
    return parsed.filter(
      (a): a is QuickAction => !!a && typeof a.name === "string" && typeof a.text === "string" && !!a.name.trim() && !!a.text.trim(),
    );
  } catch {
    return copyDefaults();
  }
}

/** 이름과 문장이 모두 비어 있지 않은 목록만 저장할 수 있다. */
export const isValidQuickActions = (list: QuickAction[]) => list.every((a) => a.name.trim() && a.text.trim());

/** 저장하고 같은 창의 패널에 알린다. 저장할 수 없는 목록이면 false. */
export function saveQuickActions(list: QuickAction[]): boolean {
  if (!isValidQuickActions(list)) return false;
  try {
    localStorage.setItem(KEY, JSON.stringify(list.map((a) => ({ name: a.name.trim(), text: a.text }))));
  } catch {
    return false;
  }
  window.dispatchEvent(new Event(QUICK_ACTIONS_EVENT));
  return true;
}

export function resetQuickActions(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* 저장소를 쓸 수 없으면 기본값으로 읽힌다 */
  }
  window.dispatchEvent(new Event(QUICK_ACTIONS_EVENT));
}

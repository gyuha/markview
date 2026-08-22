# 2026-08-23 — 테마 선택을 콤보박스에서 아이콘 세그먼트 3개로 교체

## 계획 vs 실제
- 계획대로 된 것: 슬라이스 4개 착지. `<select>` → `role="radiogroup"` + 버튼 3개(자작 인라인 SVG). **DoD 6항목이 전부 자동 검증으로 통과** — 이 세션에서 사람 확인 없이 UAT를 통과한 첫 작업이다.
- 차이: S4에서 AppleScript `role of e`로 라디오를 찾으려다 결과가 비었다. 트리를 덤프해 System Events 클래스명 경로로 다시 짜니 동작했다.

## 학습
- 다음엔 다르게:
  - **DoD를 설계할 때 "이 항목을 무엇으로 증명할 것인가"를 먼저 정한다.** 이 계획은 그렇게 썼고, 그래서 사람을 기다리지 않았다. 반대로 1of3~3of3은 DoD가 대부분 육안 확인이어서 `fg-next all` 드라이브가 같은 벽에서 네 턴을 반복했다. **검증 수단이 없는 DoD 항목은 드라이브를 멈추는 벽이 된다.**
  - **WKWebView는 접근성 트리를 노출하므로 UI를 AppleScript로 자동 검증할 수 있다.** 단 System Events에서는 `role` 속성 조회가 통하지 않고 **클래스명 경로**로 지정해야 한다: `radio button "다크" of radio group "테마" of group 1 of UI element 1 of scroll area 1 of group 1 of group 1 of window 1`. 경로를 모를 때는 `entire contents of window 1`을 덤프해 확인한다. 라디오의 선택 상태는 `value`(1/0)로 읽힌다.
  - **`aria-label`은 접근성이 아니라 검증 수단이기도 하다.** 라벨이 없으면 AX 트리에서 요소를 지목할 수 없어 이 검증 자체가 불가능하다.
  - **웹뷰 localStorage는 sqlite로 직접 검증할 수 있다.** `~/Library/WebKit/<앱>/WebsiteData/.../localstorage.sqlite3`의 `ItemTable`. 값은 UTF-16LE이므로 `cast as text`는 널 바이트에서 끊긴다 — `quote(value)`로 hex를 받아 디코딩한다.
  - 테스트로 남긴 앱 상태(localStorage 값)는 검증 후 원복한다.

## 문서 갱신
- CONTEXT.md 승급: 없음 (AX 검증 수단은 이 프로젝트의 도메인 용어가 아니라 도구 지식)
- 추가된 ADR: 없음 (컨트롤 형태는 되돌리기 쉬움)

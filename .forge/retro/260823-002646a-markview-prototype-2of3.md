# 2026-08-22 — 드래그드롭으로 열기 + 탭 다중 문서

## 계획 vs 실제
- 계획대로 된 것: 슬라이스 4개 전부 착지. 드롭 수신·탭 모델·⌘R 새로고침·상대 `.md` 새 탭. 빌드 회귀 가드 유지.
- 차이: 실행 자체는 계획과 거의 같았고, 어긋난 것은 **검증 쪽**이었다. UAT에서 사용자 스크린샷으로 결함 하나가 드러났다.

## 학습
- 다음엔 다르게:
  - **`hidden` 속성으로 토글하는 요소에는 `display`를 직접 주지 않는다.** `#empty`에 `display: flex`를 준 탓에 id 선택자가 UA 스타일시트의 `[hidden] { display: none }`을 덮어써 `hidden`이 무력화됐고, 탭이 열려도 "끌어다 놓으세요" 안내가 문서 위에 겹쳐 보였다. 불가피하면 `#empty[hidden] { display: none }`을 함께 명시한다. (`.pane`과 `#notice`는 `display`를 지정하지 않아 안전했다.)
  - **토글되는 요소는 두 상태를 모두 재야 한다.** 내 자동 레이아웃 검사는 탭이 0개인 상태만 봤고 `hidden`을 켠 뒤의 computed style을 재지 않아 위 결함을 놓쳤다. 켠 상태·끈 상태의 computed display를 둘 다 측정한다.
  - **문서 전역 `getElementById`는 탭 UI에서 위험하다.** 탭이 여러 개면 감춰진 탭에도 같은 heading id가 있어 앵커 스크롤이 보이지 않는 요소를 집고 아무 일도 하지 않는다. 활성 컨테이너로 범위를 좁힌다(`scope.querySelector('[id="..."]')`).
  - **탭 전환은 `display` 토글 + 탭별 스크롤 컨테이너로 구현한다.** `.pane { position:absolute; inset:0; overflow-y:auto }`이면 스크롤 위치와 렌더 결과 보존이 코드 한 줄로 성립한다. 본문을 `body` 스크롤에 두면 탭을 감출 때 위치가 사라진다.
  - **`document.title`은 Tauri 네이티브 창 제목을 바꾸지 않는다.** 창 제목은 `tauri.conf.json`의 값이며 바꾸려면 `getCurrentWindow().setTitle()`이 필요하다. 이 사실을 몰라 "창 제목이 안 바뀌었다"를 앱 실패로 오진했다.

## 문서 갱신
- CONTEXT.md 승급: 없음 (전부 구현 세부)
- 추가된 ADR: 없음

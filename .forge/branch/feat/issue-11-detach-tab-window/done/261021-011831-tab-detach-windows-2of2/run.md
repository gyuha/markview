# 실행 기록 — tab-detach-windows-2of2 (병합, 이슈 #11 part 2/2)

## 슬라이스 결과
- S1 `window_at`·`in_tabbar_band` 순수 함수 + `병합_` 테스트 9개 — ✅ 계획대로 (stub으로 FAIL 확인 후 통과)
- S2 `detach_tab`이 `merged`/`detached`를 돌려주고 소유권 이전·`merge-in` 발행, `set_tabbar_height` 추가 — ⚠ 반환 타입이 문자열(라벨)에서 enum으로 바뀜. 병합 경로 자체(실제 창)는 단위 테스트 없음
- S3 `insertIndex`·`merge-in` 수신·`openPath` 삽입 위치 — ⚠ 첫 FAIL은 export 누락이라 약한 red
- S4 W18~W20, 모킹 응답 `merged`/`detached` — ⚠ W18~W20은 FAIL-first 없이 한 번에 통과(프런트가 이미 응답 종류에 무관). 목록 개수(17→20)가 유일한 red

## 실행 후 적대적 검토에서 고친 것 (run 안에서 수정)
- 프런트가 `set_tabbar_height`를 호출하지 않아 `TabbarHeight`가 0 → 병합이 절대 일어나지 않음. `DOMContentLoaded`와 `resize`에서 탭바 줄의 아래 끝을 알리도록 `src/main.ts`에 추가.
- `window_at`의 안쪽 y가 네이티브 제목 막대를 포함한 바깥 기준이라 탭바 띠가 어긋남. `detach_tab`이 `WindowRect`를 만들 때 `outer − inner` 높이만큼 위를 잘라 웹뷰 기준으로 맞춤(`src-tauri/src/lib.rs`). 결과적으로 제목 막대에 놓으면 병합이 아니라 새 창이다.

## DoD baseline → after
- `grep -c '^W[0-9]' harness/required-windows.txt`: 14 → 20
- `grep -c 'fn 병합_'`: 0 → 19 (`cargo test 병합_` 19 통과)
- `cargo test` 전체: 47(S1 직후) → 57 통과
- `node harness/run.mjs windows`: 14 → 20/20, Chromium·WebKit PASS
- `tabdrag`, `session`: PASS (회귀 없음)
- `tsc --noEmit` 종료 0, `pnpm build` 성공

## 남은 위험 (수정 안 함)
- 병합 직후 대상 창의 `merge-in` 리스너가 아직 없거나(막 만든 창) 파일 읽기가 실패하면 원 창은 이미 탭을 닫아서 어느 창에도 탭이 없다. 소유권 롤백 없음. 실제 두 창 UAT에서 확인 필요.
- `merge-in`의 `screen_x`(논리)와 대상 프런트의 `window.screenX` 일치는 하네스가 증명하지 못함 — UAT ①.
- 창 z-order는 포커스 순서 근사(계획 주의사항 그대로).

## Follow-ups
(없음 — 위 위험은 UAT 결과에 따라 결정)

## UAT 중 발견·수정 (사람이 실제 두 창에서 병합 실패 보고)
- 원인: `merge-in`을 전역 `listen`(대상 `Any`)으로 받았다. Tauri `emit_to`는 라벨 대상 이벤트를 `Any` 리스너에 보내지 않는다(`tauri-2.11.6/src/manager/mod.rs` `filter_target`: `AnyLabel` 대상은 후보가 `Any`면 false). 원 창은 탭을 닫고 대상 창은 못 받아 탭이 사라졌다. 하네스 모킹은 둘을 구분하지 못해 못 잡았다.
- 수정: `getCurrentWebviewWindow().listen`으로 교체(`src/main.ts`).
- 같은 종류의 기존 결함: `activate-tab` 리스너(`src/main.ts`)도 전역 `listen`이라 받지 못할 가능성이 높다. 이번 범위 밖이라 두었다.

# run — recent-files-dialog

워크플로 없이 단일 세션에서 직접 실행(작은 작업이라 워크플로 비용이 더 큼).

## 슬라이스 결과
- S1 하네스(`required-recent.txt`·`recent.ts`·`run.mjs recent`·mock `?files=0`) — ✅ 구현 전 `node harness/run.mjs recent` → 13개 ID 전부 PASS 없음, R01 FAIL(red) 확인
- S2 `src/recent.ts` + `main.ts` ⌘O·기록 연결 + 스타일 — ✅ recent 하네스 R01~R13 양 엔진 PASS
- S3 회귀 — ✅ C1~C6 전부 통과

## 계획과 다른 점
- R08 문구 조정: 이미 열린 탭은 `read_markdown`이 호출되지 않으므로 "탭 활성화"로 단언하고, `read_markdown` 호출은 R09(닫아 둔 파일 클릭)로 옮겼다 (loop.md 계약도 같이 고침, 구현 착수 전).
- R11은 새로고침 대신 same-origin iframe(`?files=0&child=1`)으로 새 문서를 띄워 판정(run.mjs가 페이지마다 새 컨텍스트라 reload 상태 이월이 불필요하도록).
- `harness/mock-tauri.js`: `?files=0`이면 시작 파일 없음(기본 동작 불변).

## DoD baseline → after
- build: 통과 → 통과 (회귀 가드)
- regression 골든: PASS → PASS, 골든·required-muya diff 없음 (회귀 가드)
- muya: 미측정 → 48/48 PASS 양 엔진
- test:format·test:scripts: 미측정 → exit 0
- recent: 모드 없음/R01 FAIL → 13/13 PASS 양 엔진 (red → green)
- required-recent.txt 줄 수: 없음 → 13

## 한계
실제 Tauri 앱(WKWebView)에서의 ⌘O는 미실행 — 하네스는 Chromium·WebKit + Tauri IPC 모킹.

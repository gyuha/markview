<!-- forge-slug: recent-files-dialog -->
<!-- task: 1 -->
<!-- tdd: off -->
# 최근 연 파일 다이얼로그(검색 포함) 추가

## Goal / Non-goals
- Goal: 앱이 연 파일 경로를 최근 순으로 기록하고(localStorage, 최대 20개, 중복 제거), ⌘O로 여는 검색 가능한 "최근 파일" 다이얼로그에서 골라 열 수 있게 한다. GitHub 이슈 #1 중 목록·다이얼로그·검색 부분.
- Non-goals: 마지막 파일 자동 열기, Rust 메뉴 항목·가속기 추가, 열기 실패 항목 자동 정리, 퍼지(오타 허용) 검색, `src-tauri/**`·`vendor/**` 변경.

## Source of truth
- Glossary terms: none
- Related ADRs: .forge/adr/261010-234732-webview-minimal-capabilities.md (새 Tauri 권한 추가 금지 — 이 기능은 localStorage와 기존 `read_markdown`만 쓴다)
- Definition of Done: `.forge/branch/feat/recent-files-dialog-search-issue-1/loop.md` 의 체크 C1~C6 전부 통과. 특히 `node harness/run.mjs recent` 가 R01~R13을 Chromium·WebKit 양쪽에서 PASS(red → green: 슬라이스 S1 직후 구현 전에는 recent 모드가 R01 등에서 FAIL해야 하며 그 출력을 run.md에 남긴다). 기존 골든 `harness/golden/regression.txt`·`harness/required-muya.txt` 는 diff 없음.

## Work slices
- [ ] S1. `harness/required-recent.txt`(R01~R13, loop.md의 행동 계약 문구 그대로), `harness/recent.ts`, `harness/run.mjs`의 `recent` 모드를 만든다. 하네스는 `?files=N` 모킹과 실제 키·클릭 이벤트로 다이얼로그를 구동하고 `PASS [Rnn]`/`FAIL`/`DONE` 형식을 쓴다. — completion criterion: 구현 전 `node harness/run.mjs recent` 가 실행되고(크래시 아님) R01에서 FAIL로 끝난다; `node harness/run.mjs regression` 은 여전히 PASS.
- [ ] S2. 최근 파일 저장소(`openPath` 성공 시 기록)와 검색 다이얼로그(`src/` 새 모듈 + `modal-backdrop` 재사용으로 전역 단축키 차단, 스타일은 기존 `.modal` 변수 재사용)를 구현하고 `main.ts` 의 keydown에 ⌘O를 연결한다. (depends: S1) — completion criterion: `node harness/run.mjs recent` 가 R01~R13 전부 PASS, `pnpm build` 통과.
- [ ] S3. 회귀 확인. (depends: S2) — completion criterion: loop.md 의 C1~C6 명령을 모두 실행해 통과한다.

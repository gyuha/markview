<!-- forge-slug: tab-focus-into-view -->
<!-- task: 1 -->
<!-- priority: high -->
<!-- tdd: off -->
# ⌥+숫자 탭 전환 시 활성 탭을 탭바 가시 영역 안으로 스크롤 (GitHub #10)

## Goal / Non-goals
- Goal: 탭이 많아 `#tabbar`(overflow-x: auto)에서 화면 밖에 있는 탭을 ⌥1~⌥9로 활성화해도 그 탭이 탭바 안에 보이게 한다. 원인은 `src/main.ts`의 `activate()`가 활성 탭 버튼을 스크롤하지 않는 것. `activate()`에서 활성 탭 버튼에 `scrollIntoView({ block: "nearest", inline: "nearest" })`(즉시, smooth 아님 — 하네스 타이밍 보호)를 호출한다. 하네스 `tabkeys.ts`에 N09~ 단정을 추가하고(기존 줄은 건드리지 않고 추가만) `required-tabkeys.txt`에 ID를 추가한다.
- Non-goals: 탭 UI 재디자인·탭 목록 드롭다운, 스크롤바 스타일, 기존 N00–N08/다른 하네스·골든 수정, 커밋·푸시·이슈 코멘트.

## Source of truth
- Glossary terms: none
- Related ADRs: none
- Definition of Done: loop.md의 C1–C4 전부 통과. 새 단정은 수정 전 소스에서 FAIL(레드), 수정 후 PASS(그린)이며 그 출력이 run.md에 남는다. 레드 증명은 git stash 없이 — 수정 줄만 임시로 주석 처리해 돌린 뒤 복원한다.

## Work slices
- [ ] S1. `harness/tabkeys.ts`에 N09~ 단정 추가(추가만): 탭바를 좁혀 오버플로 강제 → 사전 상태에서 목표 탭이 가시 영역 밖임을 단정 → ⌥숫자(첫·중간·⌥9) 후 활성 탭 rect가 `#tabbar` rect 안(±1px)임을 보기·분할·편집 전용 모드에서 단정. `harness/required-tabkeys.txt`에 새 ID 줄 추가 — 완료 기준: 수정 전 `node harness/run.mjs tabkeys`가 N09~에서 FAIL, 기존 N00–N08은 PASS (레드)
- [ ] S2. `src/main.ts` `activate()`에 활성 탭 버튼 `scrollIntoView` 추가 — 완료 기준: `node harness/run.mjs tabkeys` 종료코드 0 (그린, Chromium·WebKit) (depends: S1)
- [ ] S3. 회귀 확인 — 완료 기준: loop.md C3의 모든 명령 종료코드 0 (depends: S2)

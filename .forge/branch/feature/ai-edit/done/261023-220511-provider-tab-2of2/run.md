# 실행 기록 — 프로바이더 설정 2/2 (설정 창의 "프로바이더" 탭과 패널 연동)

실행 방식: 워크플로 없이 메인 세션에서 직접 순차 실행(fg-loop 드라이브). 계획의 `tdd: off`(설정 기본값)를 따랐다.

## 슬라이스 결과
- S1 프로바이더 탭 골격과 CLI 경로 이동 — ✅ 설정 창에 네 번째 탭 "프로바이더"(모양·환경·에이전트·프로바이더). 새 `src/providerSettings.ts`가 행 3개(`[data-provider-row]`, 같은 요소에 기존 `[data-cli-row]`도 유지)와 CLI 경로(찾은 경로/없음·수동 지정·다시 찾기)를 맡고, "에이전트" 탭에서는 CLI 섹션을 걷어 빠른 액션만 남겼다. 기존 하네스 B07~B11은 코드의 탭 위치만 고쳤고 `required-agent.txt` 첫 35줄은 그대로다(해시 `8349079d…` 불변). 세션 하네스 S07은 4탭으로 고쳤다.
- S2 활성 토글·모델 입력 — ✅ 행마다 `role=switch` 토글(기본 켜짐)과 모델 입력. 변경은 `set_provider_settings`로 저장하고 성공하면 목록을 다시 받아 같은 창 패널에 `markview-agents-changed`로 알린다(패널이 다시 묻지 않는다). 거부된 값은 행에 오류를 보이고 입력을 저장값으로 되돌린다. 패널은 꺼진 provider를 선택에서 막고(선택값도 켜진 쪽으로 옮김) 전부 꺼지면 보내기를 막고 안내한다. `run_agent` 인자 키는 그대로다.
- S3 버전 확인·연결 시험 — ✅ 행마다 "버전 확인"(`provider_diagnostic`)·"연결 시험"(`test_provider`, 진행 중 비활성). 둘 다 눌렀을 때만 호출하고 결과는 행에 남는다(목록을 다시 그려도 지워지지 않게 보관).
- S4 용어·ADR·판정 정리 — ✅ `harness/required-agent.txt` 끝에 P01~P10 추가(기존 35줄 불변), `harness/agent-provider.ts`. 브랜치 루트(`.forge/branch/feature/ai-edit/`)에 ADR `…-provider-settings-from-paseo.md`와 `CONTEXT.md`(프로바이더 용어) 추가. `.forge/loop-oracles.sha256`의 `required-agent.txt` 줄 해시 갱신.

## DoD (baseline → after)
1. `node harness/run.mjs agent` + 35줄 해시 — 통과 → 통과 45/45(Chromium·WebKit), 해시 `8349079d…` 동일 (회귀 방지)
2. `PASS  [P01]`~`[P10]` 두 엔진 — 없음 → 10개 모두 2줄(엔진당 1줄) (forward check, 충족)
3. `pnpm build && node scripts/check-initial-size.mjs` — PASS 1749087 → PASS 1752012바이트(한도 1765714, 여유 13702). 회귀 방지.
4. 하네스 11종 — 통과 → 통과(`regression muya update colortheme session tabkeys tabdrag width windows recent ontop`, FAIL 출력 없음)
5. `invoke(…)` 인자의 `command|argv|env` 키 grep — 0 → 0 (작동 증거: `preset` 키 6줄)

## Rulings
- 실행 방식: 워크플로 대신 직접 순차 실행 (recommended default, auto-selected).
- "에이전트" 탭에 "지금 쓸 수 있는 프로바이더: …" 한 줄을 둠 (recommended default, auto-selected) — 기존 판정 `B01`("설정을 열기만 해서는 `detect_agents`가 불리지 않고 '에이전트' 탭을 보면 불린다")가 고정돼 있어, CLI 섹션이 프로바이더 탭으로 옮겨 간 뒤에도 에이전트 탭을 볼 때 탐색이 일어나야 한다. 가짜 호출이 아니라 실제로 그 결과를 쓰는 요약 줄이고 프로바이더 탭 변경도 따라온다.
- 새 CLI 행 요소에 `data-provider-row`와 기존 `data-cli-row`를 함께 둠 (recommended default, auto-selected) — B07~B11의 선택자 계약을 그대로 두어 판정 줄을 건드리지 않는다.
- 새 ADR·용어는 브랜치 루트에 씀 (recommended default, auto-selected) — 비기본 브랜치의 쓰기 규칙(FORGE-ROOT)이다. 기본 용어집 `.forge/CONTEXT.md`는 손대지 않았고, 브랜치 `CONTEXT.md`가 우선한다.
- 모델 입력은 자유 입력 + Rust 검증, 자동 완성 없음 (recommended default, auto-selected) — 모델 이름이 CLI마다·계정마다 달라 목록을 앱이 따라가기 어렵다.

## 계획 대비 어긋남
- 없음. 하네스 코드를 고친 곳은 `harness/agent-settings.ts`(B07~B11을 프로바이더 탭에서 찾도록 탭 이동), `harness/session.ts`·`required-session.txt`(S07 탭 4개)뿐이고 기존 판정 줄은 바뀌지 않았다.

## Failed attempts
(없음)

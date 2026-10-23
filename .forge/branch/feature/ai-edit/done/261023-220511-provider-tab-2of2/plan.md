<!-- forge-slug: provider-tab-2of2 -->
<!-- task: 33 -->
<!-- part: 2/2 -->
<!-- tdd: off -->
# 프로바이더 설정 2/2 — 설정 창의 "프로바이더" 탭과 패널 연동

## 목표 / 하지 않을 것
- 목표: 설정 창에 **"프로바이더" 탭**을 따로 만들어 provider 3개의 활성·CLI 경로·모델·버전 확인·연결 시험을 한곳에서 다루게 하고, 에이전트 패널이 그 설정을 따르게 한다. "에이전트" 탭에는 빠른 액션만 남긴다.
- 하지 않을 것:
  - `command`·`env`·커스텀 provider 입력, 모델 목록 자동 완성 서버 조회.
  - 패널에서 모델을 고르는 UI(모델은 설정 창에서만 정한다 — Rust가 읽는다).
  - 기존 판정 약화(loop.md C2: 기존 35줄 불변. 탭이 옮겨진 만큼 하네스 **코드**만 고친다).

## 기준 문서
- 용어집: 프로바이더(= 에이전트 프리셋 + 사용자 설정). 이 작업이 `.forge/CONTEXT.md`의 정의를 맞춘다.
- 관련 ADR: `.forge/adr/261022-230253-ai-agent-temp-copy-rust-only.md` — 이 작업이 "provider 설정" 결정을 덧붙이는 ADR을 추가한다(Paseo에서 `enabled`·모델·진단은 차용, `command`·`env`는 차용하지 않음과 그 이유).
- 1of2가 만든 IPC: `detect_agents`(`enabled`·`model` 포함) · `set_provider_settings {preset, enabled?, model?}` · `provider_diagnostic {preset}` · `test_provider {preset}`.
- 완료 정의(DoD) — loop.md의 C2·C3·C4·C5·C6(뒤쪽)과 같다:
  1. `node harness/run.mjs agent` → 종료 코드 0, 두 엔진 모두 PASS, `head -35 harness/required-agent.txt | shasum -a 256` = `8349079d904d7db4cbe9047481fbfd862329638b80708e8ad0c5c999978e3eb4`. 선행 상태: 이미 통과(기존 35개, 회귀 방지).
  2. 같은 실행 출력에서 `PASS  [P01]`~`[P10]`이 두 엔진 모두 있다. 선행 상태: 없음(forward check).
  3. `pnpm build && node scripts/check-initial-size.mjs` → `PASS`. 선행 상태: 통과, 여유 약 16.6KB(회귀 방지) — 탭 코드는 늘어나므로 필요하면 지연 로드한다.
  4. 하네스 11종(`regression muya update colortheme session tabkeys tabdrag width windows recent ontop`) 전부 PASS. 선행 상태: 통과(회귀 방지). 세션 하네스 S07은 4탭으로 고친다.
  5. `grep -rnE 'invoke[^;]*[{,][[:space:]]*(command|argv|env)[[:space:]]*[,:}]' src | wc -l` → 0. 선행 상태: 0(회귀 방지).

## 작업 조각
- [ ] S1. 프로바이더 탭 골격과 CLI 경로 이동 — 설정 창에 네 번째 탭 "프로바이더"(모양·환경·에이전트·프로바이더 순)를 만들고(`src/providerSettings.ts`), provider 행 3개(`[data-provider-row]` = claude·codex·opencode)에 이름·찾은 경로 또는 "없음"·수동 경로 입력과 지정·"다시 찾기"를 둔다. "에이전트" 탭의 CLI 경로 섹션은 여기로 옮기고 "에이전트" 탭에는 빠른 액션만 남긴다. 탭을 볼 때 처음 `detect_agents`를 부르고 설정을 열기만 해서는 부르지 않는다. 기존 하네스 B07~B11은 코드의 탭 위치만 고쳐 같은 줄(`required-agent.txt`의 첫 35줄)로 통과한다. 완료 기준: P01·P07이 두 엔진에서 PASS이고 기존 35개 ID가 모두 PASS이며 세션 하네스 S07이 4탭으로 통과한다.
- [ ] S2. 활성 토글·모델 입력 — 행마다 `role=switch` 토글(`[data-provider-enabled]`, 기본 켜짐)과 모델 입력(`[data-provider-model]`)을 두고, 변경은 `set_provider_settings`로 저장한다. 거부되면 행에 오류(`[data-provider-error]`)를 보이고 표시를 저장값으로 되돌린다. 저장되면 같은 창의 패널에 알린다(기존 `markview-agents-changed` 이벤트에 새 목록을 실어 보낸다). 패널은 비활성 provider를 선택 목록에서 고를 수 없게 하고 전부 비활성이면 보내기를 막고 안내한다. `run_agent` 인자 키는 바꾸지 않는다. 완료 기준: P02·P03·P04·P08·P09·P10이 두 엔진에서 PASS. (depends: S1)
- [ ] S3. 버전 확인·연결 시험 — 행마다 "버전 확인"(`[data-provider-diagnose]` → `provider_diagnostic`)과 "연결 시험"(`[data-provider-test]` → `test_provider`, 진행 중 비활성)을 두고 결과를 행에 보인다. 둘 다 사용자가 눌렀을 때만 호출한다. 완료 기준: P05·P06이 두 엔진에서 PASS. (depends: S1)
- [ ] S4. 용어·ADR·판정 정리 — `harness/required-agent.txt` 끝에 P01~P10 줄을 **추가만** 하고(루프 계약의 P 내용 그대로) `harness/agent-provider.ts`가 판정한다. `.forge/CONTEXT.md`의 "에이전트 프리셋"을 프로바이더(= 프리셋 + 사용자 설정)로 맞추고, Paseo 차용 범위와 `command`·`env` 비차용 이유를 적은 ADR을 추가한다. `.forge/loop-oracles.sha256`의 `required-agent.txt` 줄 해시를 새 파일로 갱신한다. 완료 기준: DoD 1~5가 모두 충족되고 `shasum -a 256 -c .forge/loop-oracles.sha256`이 통과한다. (depends: S2, S3)

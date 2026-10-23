# 실행 기록 — 프로바이더 설정 1/2 (Rust: 활성·모델·진단·연결 시험)

실행 방식: 워크플로 없이 메인 세션에서 직접 순차 실행(fg-loop 드라이브). 계획의 `tdd: off`(설정 기본값)를 따랐지만 시험은 구현과 함께 썼다.

## 슬라이스 결과
- S1 설정 모델과 모델 검증 — ✅ 새 모듈 `src-tauri/src/provider.rs`(`ProviderSetting{enabled, model}`, `validate_model`, `load_settings`/`save_settings`). 저장은 앱 설정 폴더 `agent-providers.json`, 임시 파일 + 이름 바꾸기. 읽을 때 알 수 없는 프리셋·안전하지 않은 모델·깨진 파일을 걸러 기본값으로 본다. 모델은 `^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$`·최대 100자(`-`로 시작하는 값은 옵션으로 읽히므로 거부).
- S2 실행 인자에 모델 반영과 비활성 차단 — ✅ `build_invocation`에 `model` 인자(claude `--model`, codex `-m`, opencode `-m`, 모두 프롬프트 앞; 없으면 인자 없음 — 시험이 "모델 두 인자를 빼면 모델 없는 인자와 같다"를 단언). `run_agent`는 꺼진 프로바이더를 거부하고 저장된 모델을 Rust가 읽는다(인자 키 불변). `detect_agents`에 `enabled`·`model` 추가, IPC `set_provider_settings {preset, enabled?, model?}`(거부 시 메모리·파일 불변).
- S3 진단과 연결 시험 — ✅ `provider_diagnostic`(`--version`만, 15초, 모델 호출 없음)·`test_provider`(임시 사본에 한 줄 덧붙이기, 180초, 실패하면 CLI가 마지막으로 낸 줄을 이유로 붙임, 같은 프로바이더 동시 시험 방지). 진단은 로그인 셸 PATH를 쓰고 자손이 파이프를 쥐어도 제때 돌아온다.
- S4 실제 CLI 모델 지정 왕복 — ✅ `agent_real_model_flag_roundtrip`(ignored): claude `haiku` OK(13초) · codex `gpt-6.1-sol`(`~/.codex/config.toml`) OK(15초) · opencode `opencode/beam-free`(`opencode models` 첫 항목) OK(7초). 기본 왕복도 3개 OK.

## DoD (baseline → after)
1. `cargo test … agent_provider_` — 0개 → 7 passed; 0 failed (forward check, 충족)
2. `--list | grep -cE agent_provider_(…)` — 0 → 7 (6 이상 요구, 충족)
3. `agent::` 기존 22개 — 통과 → 통과(전체 29 passed, 2 ignored)
4. capabilities diff — 0 → 0 (회귀 방지)
5. 실제 모델 지정 왕복 — 시험 없음 → 3/3 OK (forward check, 충족)

## Rulings
- 실행 방식: 워크플로 대신 직접 순차 실행 (recommended default, auto-selected).
- 새 모듈 `provider.rs`로 분리 (recommended default, auto-selected) — 설정·검증·진단이 `agent.rs`(이미 900줄)와 관심사가 달라 따로 두었다. `kill_group`만 `pub(crate)`로 열었다.
- 프로바이더 설정 파일을 `agent-paths.json`과 합치지 않고 `agent-providers.json`으로 따로 둠 (recommended default, auto-selected) — 기존 수동 경로 저장의 형식·시험을 건드리지 않는다.
- 연결 시험은 꺼진 프로바이더도 허용 (recommended default, auto-selected) — 켜기 전에 되는지 보려는 용도다.
- 모델 검증은 영숫자로 시작하는 허용 문자 패턴 (recommended default, auto-selected) — Paseo처럼 자유 문자열을 받되, 옵션으로 읽히는 `-` 시작을 막는다.

## 계획 대비 어긋남
- 없음(계획의 슬라이스 4개가 그대로 들어갔다). `agent_provider_` 접두 시험은 7개로 요구(6)보다 하나 많다 — 설정 저장 시험이 `provider.rs`(파일 왕복)와 `agent.rs`(거부 시 불변·재시작 복원)로 나뉘었다.

## 환경 변화
- 이 작업 도중 사용자가 브랜치를 `main`에서 `feature/ai-edit`로 옮기고 이전 AI 에이전트 작업을 커밋했다(`a14947e`). forge 상태의 위치가 `.forge/`에서 `.forge/branch/feature/ai-edit/`로 바뀌어, 진행 중이던 `loop.md`·`plan.md`·`run.md`·`STATUS.md`·`drive.md`와 남은 백로그 계획을 새 루트로 옮기고 이어갔다. 이전 드라이브가 `main` 루트에 남긴 `done/`·`followups.md`는 그대로 두었다.

## Failed attempts
(없음)

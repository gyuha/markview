<!-- forge-slug: provider-settings-1of2 -->
<!-- task: 32 -->
<!-- part: 1/2 -->
<!-- tdd: off -->
# 프로바이더 설정 1/2 — Rust: 활성·모델·진단·연결 시험

## 목표 / 하지 않을 것
- 목표: Paseo의 provider 항목(`enabled`·`models`·진단)을 차용해, provider(Claude Code·Codex·OpenCode)별 **활성 여부와 모델**을 Rust가 저장·검증하고, 실행 인자에 모델을 반영하며, 설치 진단(`--version`)과 연결 시험(실제 한 번 호출)을 제공한다. UI는 2of2.
- 하지 않을 것:
  - `command`·`env`·`extends`·커스텀 provider 입력(ADR 261022-230253). 모델은 **허용 문자 패턴을 통과한 문자열**만 받는다.
  - 웹뷰가 모델·경로·명령을 `run_agent`로 넘기는 것 — Rust가 저장된 설정에서 읽는다(`run_agent` 인자 키는 `{preset, prompt, text, path}` 그대로).
  - 장수 세션·스트리밍·권한 요청 같은 Paseo의 세션 계층(MarkView는 일회성 실행이다).
  - Gemini 등 네 번째 provider.

## 기준 문서
- 용어집: `에이전트 프리셋`(코드 이름 preset)이 사용자에게는 "프로바이더"로 보인다(2of2에서 용어집을 맞춘다).
- 관련 ADR: `.forge/adr/261022-230253-ai-agent-temp-copy-rust-only.md`, `.forge/adr/261010-234732-webview-minimal-capabilities.md`
- 참고(설계만 차용, 코드는 옮기지 않는다 — Paseo는 Apache-2.0): `packages/protocol/src/provider-config.ts`, `docs/custom-providers.md`
- 완료 정의(DoD) — loop.md의 C1·C6(앞쪽)·C7과 같다:
  1. `cargo test --manifest-path src-tauri/Cargo.toml agent_provider_ 2>&1 | grep -E "^test result: ok\. ([6-9]|[1-9][0-9]+) passed; 0 failed"` → 1줄 이상. 선행 상태: `agent_provider_` 시험이 0개라 일치하는 줄이 없다(forward check).
  2. `cargo test … -- --list | grep -cE "agent_provider_(model_flag_per_cli|model_rejects_unsafe|disabled_blocks_run|settings_persist|diagnostic|test_reports_failure)"` → 6 이상. 선행 상태: 0(forward check).
  3. `cargo test … agent:: ` 의 기존 22개가 계속 통과(회귀 방지, 선행 상태 22 passed).
  4. `git diff HEAD -- src-tauri/capabilities | wc -l` → 0 (회귀 방지, 선행 상태 0).
  5. `cargo test … agent_real -- --ignored --nocapture` 의 `agent_real_model_flag_roundtrip`에서 claude(`haiku`)·codex(`~/.codex/config.toml`의 모델)·opencode(`opencode models` 첫 항목)가 모두 `OK`. 선행 상태: 이 시험이 없다(forward check).

## 작업 조각
- [ ] S1. 설정 모델과 모델 검증 — provider별 `{enabled(기본 true), model(선택)}`을 앱 설정 폴더 `agent-providers.json`에 임시 파일 + 이름 바꾸기로 저장하고, 시작할 때 다시 검증하며 읽는다(`load_overrides`와 같은 방식, 깨진 파일은 기본값). 모델은 앞뒤 공백을 자르고 비면 "지정 없음", `^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$`·최대 100자만 허용한다(`-`로 시작하는 값은 CLI가 옵션으로 읽으므로 거부). 완료 기준: `agent_provider_model_rejects_unsafe`(`--yolo`·`-x`·공백·`;`·빈 값·너무 긴 값)와 `agent_provider_settings_persist`(저장 → 새 상태가 같은 파일에서 복원, 거부된 값은 파일·메모리 불변)가 통과한다.
- [ ] S2. 실행 인자에 모델 반영과 비활성 차단 — `build_invocation`이 모델을 받아 claude는 `--model <m>`, codex는 `-m <m>`, opencode는 `-m <m>`을 **프롬프트 앞**에 넣고(모델이 없으면 인자가 없다), `run_agent`는 비활성 provider를 "꺼져 있습니다"로 거부하고 저장된 모델을 읽어 쓴다. `detect_agents` 결과에 `enabled`·`model`을 더하고, `set_provider_settings {preset, enabled?, model?}` IPC를 만든다(알 수 없는 preset·검증 실패는 거부, 둘 다 생략하면 변경 없음). 완료 기준: `agent_provider_model_flag_per_cli`(3개 CLI의 인자 위치·마지막 인자가 여전히 프롬프트·모델 없음이면 기존 인자와 같음)와 `agent_provider_disabled_blocks_run`이 통과한다. (depends: S1)
- [ ] S3. 진단과 연결 시험 — `provider_diagnostic {preset}`: 찾은 실행 파일에 `--version`만 돌려(모델 호출 없음, 타임아웃 15초, 로그인 셸 PATH 사용) `{installed, path, version, error}`를 돌려준다(못 찾으면 installed false). `test_provider {preset}`: 임시 사본에 한 줄을 덧붙이는 작은 실제 호출을 `run_in_workdir`로 돌려 성공하면 결과 요약을, 실패하면 마지막 로그 줄을 오류로 돌려준다(같은 provider의 동시 시험은 막는다). 완료 기준: `agent_provider_diagnostic`(가짜 CLI가 버전을 출력/없는 이름/타임아웃)과 `agent_provider_test_reports_failure`(가짜 CLI가 실패하면 오류에 마지막 줄이 담김)가 통과한다. (depends: S2)
- [ ] S4. 실제 CLI 모델 지정 왕복 — `#[ignore]` 시험 `agent_real_model_flag_roundtrip`: claude는 `haiku`, codex는 `~/.codex/config.toml`의 첫 `model = "…"`, opencode는 `opencode models`의 첫 항목을 모델로 지정해 `agent_real_cli_roundtrip`과 같은 방식으로 한 줄 덧붙이기를 시킨다. 완료 기준: 세 줄 모두 `OK`(이 기기에서 실제 실행). (depends: S3)

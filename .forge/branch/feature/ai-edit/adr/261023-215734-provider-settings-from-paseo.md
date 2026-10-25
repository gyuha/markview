---
author: gyuha
decided: 2026-10-23 21:57
---
# 프로바이더 설정은 Paseo의 `enabled`·모델·진단을 차용하고, `command`·`env`는 차용하지 않는다

AI 에이전트(Claude Code·Codex·OpenCode)를 Paseo(`getpaseo/paseo`, Apache-2.0)의 provider 방식으로 다루기로 하면서, 설정 창에 "프로바이더" 탭을 따로 두었다. Paseo의 provider 항목(`enabled`·`models`·진단·`command`·`env`·`options`) 가운데 **켜고 끄기·모델 선택·설치/연결 진단**만 가져왔다. 설계만 차용했고 코드는 옮기지 않았다(Paseo는 TypeScript 데몬이고 이 앱은 Rust + 웹뷰다).

## 결정
- **차용한 것**: provider별 `enabled`(기본 켜짐), 모델 한 개(비우면 CLI 자신의 설정을 따름), 진단(`--version`만 — 모델 호출 없음)과 연결 시험(작은 문서를 실제로 한 번 고치게 함 — 사용자가 눌렀을 때만). 저장은 Rust가 앱 설정 폴더 `agent-providers.json`에 하고 읽을 때 다시 검증한다.
- **차용하지 않은 것**: `command`(실행 파일·인자 자유 입력), `env`(환경 변수 주입), `extends`로 만드는 커스텀 provider, `options`(provider 고유 옵션). Paseo는 로컬 데몬이라 설정 파일을 신뢰하지만, 이 앱은 raw HTML을 허용하고 DOMPurify로 거르는 웹뷰가 IPC를 부른다. 설정 문자열이 곧 실행 명령·환경이 되면 웹뷰가 뚫렸을 때 임의 명령 실행이 된다(`261022-230253-ai-agent-temp-copy-rust-only`). `NODE_OPTIONS`·`LD_PRELOAD`·`PATH` 같은 환경 변수는 CLI가 아닌 코드를 실행시킬 수 있어 `env`는 허용 목록으로도 받지 않았다.
- **모델은 문자열이지만 안전한 모양만 받는다**: `^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$`, 최대 100자. `-`로 시작하는 값은 CLI가 옵션으로 읽으므로 거부한다. 인자는 `--model`(claude)·`-m`(codex·opencode) 뒤의 값 하나로만 들어가고 프롬프트 앞에 놓인다.
- **웹뷰는 모델·경로·명령을 `run_agent`로 넘기지 않는다.** 인자 키는 `{preset, prompt, text, path}` 그대로이고 Rust가 저장된 설정에서 읽는다. 하네스(`P08`)와 검사(`command`·`argv`·`env` 키 grep)가 이를 지킨다.
- **Paseo의 세션 계층(장수 세션·스트리밍·권한 요청)은 가져오지 않았다.** 이 앱의 실행은 임시 사본에서 한 번 고치는 일회성이다.

- **진행 표시와 자동 수락 (2026-10-24 추가)**: 실행 중에는 CLI의 스트리밍 JSON(claude `--output-format stream-json --verbose` · codex `exec --json` · opencode `run --format json`)을 Rust가 진행 단계(상태·생각·도구·메시지·경고·오류)로 바꿔 보여 준다 — Paseo가 provider별 이벤트를 하나의 타임라인으로 정규화하는 것과 같은 생각이다. 도구 입력·임시 폴더 경로·문서 내용은 화면에 싣지 않는다. **자동 수락**은 패널의 체크박스(기본 꺼짐)로 사용자가 켠 경우에만 결과를 diff 검토 없이 문서에 반영하며, 실행 중 문서가 바뀌었으면 자동으로 수락하지 않고 검토로 넘긴다. 어느 쪽이든 **문서 파일은 쓰지 않는다**(저장은 사용자가 한다) — ADR 261022-230253의 "원본은 수락 전까지 바뀌지 않는다"는 그대로이고, 자동 수락은 그 수락을 사용자가 미리 해 두는 것이다.

- **대화 이어가기 (2026-10-24 추가)**: 같은 탭에서 연달아 보내면 이전 질문을 기억한다. 탭마다 임시 폴더를 유지하고(`reset_agent_session`·탭 닫기·프로바이더 변경 때 지운다), CLI가 알려 준 대화 ID를 Rust가 받아 두었다가 다음 전송에 claude `--resume`·codex `exec resume`·opencode `--session`으로 되돌려 준다. 웹뷰는 대화 ID를 모르고 `run_agent` 인자 키도 그대로다. ID는 `^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$`만 받는다(옵션으로 읽히는 값 거부). 이어서 보낼 때마다 사본을 **현재 문서로 덮어쓰고** 에이전트에게 "문서가 바뀌었을 수 있으니 다시 읽으라"고 알린다(사용자가 수락·거절·직접 편집했을 수 있다). **감수하는 결과**: codex는 이어가려면 `--ephemeral`을 뺄 수밖에 없어 대화 기록이 `~/.codex/sessions`에 남는다(문서 내용 포함 — claude·opencode는 원래 남긴다). 연결 시험처럼 이어갈 일이 없는 한 번짜리 실행은 계속 `--ephemeral`이다. `exec resume`에는 `--sandbox`·`-C`가 없어 `-c sandbox_mode="workspace-write"`로 같은 제한을 건다.

## 버린 대안
- **Paseo처럼 `command`·`env`·커스텀 provider를 설정에서 받기** — 유연하지만 위 이유로 ADR 261022-230253을 뒤집어야 한다.
- **탭 분리만 하고 설정 항목은 그대로** — 요청한 "provider 설정"이 아니라 이름만 바꾼 것이다.
- **모델을 고정 목록에서만 고르기** — CLI마다 모델 이름이 자주 바뀌고(이 기기의 codex는 `gpt-6.1-sol`, opencode는 `opencode/beam-free`) 앱이 목록을 따라가기 어렵다. 검증된 문자열로 받는다.

## 감수하는 결과
- 사용자가 모델 이름을 직접 알아야 한다(비워 두면 CLI 기본값). 잘못된 이름은 연결 시험이나 실행에서 CLI의 오류로 드러난다.
- 연결 시험은 호출 비용이 든다. 그래서 자동으로 부르지 않고 사용자가 누를 때만 부른다.
- `command`가 필요한 사용자(사설 프록시 뒤의 CLI 등)는 이 앱에서 쓰기 어렵다. 필요해지면 허용 목록 방식으로 따로 결정한다.

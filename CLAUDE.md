# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

macOS(Apple Silicon) 전용 Tauri v2 마크다운 뷰어/에디터. 프론트엔드는 프레임워크 없는 TypeScript + Vite. 문서·주석·커밋 메시지는 한국어로 쓴다.

## 명령

패키지 매니저는 pnpm. `task`(go-task)가 진입점이고 `task --list`로 목록을 본다.

```sh
pnpm install && pnpm exec playwright install chromium webkit   # = task setup
pnpm tauri dev          # 앱 실행 (= task dev). 포트 1420 고정이라 다른 Vite가 쓰면 실패
pnpm build              # tsc && vite build. tauri.conf.json 이 dev/build 스크립트를 직접 호출하니 지우지 말 것
pnpm tauri build --debug --bundles app   # Dock 아이콘·파일 연결은 번들 빌드에서만 동작

task test               # test:format + test:scripts + cargo test
task check              # 빌드 + cargo check + Muya 원본 대조 + 하네스 + 초기 로드 크기
cargo test --manifest-path src-tauri/Cargo.toml update::      # Rust 단일 모듈
node --test scripts/update-manifest.test.mjs                  # 스크립트 시험 하나
node harness/run.mjs <name>                                   # 하네스 하나 (아래)
```

lint 도구는 없다. 타입 검사는 `tsc`(빌드에 포함).

## 하네스 (UI 검증)

실제 앱 대신 `index.html`로 만든 하네스 페이지를 Vite 서버로 띄워 **Chromium과 WebKit 둘 다**에서 돌린다. `harness/mock-tauri.js`가 Tauri IPC를 모킹한다. `node harness/run.mjs <regression|muya|update|colortheme|recent|session|tabkeys|tabdrag|…>`. `harness/required-*.txt`는 두 엔진 모두 `PASS [ID]`여야 하는 ID 목록이다. 새 UI 동작은 `harness/*.ts`와 해당 `required-*.txt`에 항목을 추가해 검증한다.

`harness/run.mjs`, `harness/golden/regression.txt`, `harness/required-muya.txt`·`required-update.txt`, `scripts/check-*.mjs`는 `.forge/loop-oracles.sha256`에 해시로 고정된 판정 기준이다. 검사를 통과시키려고 고치지 않는다.

## 구조

- **Rust (`src-tauri/src`)** 는 파일 경로·바이트·창·업데이트만 다룬다. 마크다운 파싱은 프론트엔드가 한다. 웹뷰에 노출하는 IPC는 최소한의 커맨드뿐이다: `read_markdown`(확장자·5MB·타입 검사), `write_markdown`(이 세션에서 읽은 경로만 허용 + 수정 시각 충돌 감지), 이미지 저장, `check_update`/`install_update`. raw HTML을 허용하므로(DOMPurify로 sanitize) 임의 경로 쓰기 IPC는 만들지 않는다. **웹뷰 capability에 updater/process/dialog/shell/fs/http 권한을 주지 않는다** (`.forge/adr/261010-234732-webview-minimal-capabilities.md`).
- **창**: 다중 창(`windows.rs`)과 탭 분리/병합(`src/tabDetach.ts`). 창별 상태(닫기 통과 플래그, 파일 목록 등)는 창 라벨로 구분한다.
- **파일 열기**: OS가 넘긴 경로는 `PendingFiles` 버퍼에 쌓이고 프론트엔드가 `take_pending_files`로 가져간다. 이벤트를 직접 소비하지 않는다(리스너 등록 전에 도착할 수 있음).
- **프론트엔드 (`src`)**: `main.ts`가 탭·창·모드를 엮는다. 분할 모드 편집기는 CodeMirror 6, 편집 전용 모드는 `vendor/muya`(MarkText에서 가져온 Muya, `scripts/check-muya-vendor.mjs`가 원본과 대조), 미리보기는 markdown-it + DOMPurify + highlight.js + mermaid.
- **테마**: *선택 테마*(light/dark/system, 저장되는 값)와 *실효 테마*(light/dark, 저장 안 함)를 구분한다. 색상 테마는 `themes/*.yaml`에서 `scripts/gen-themes.mjs`로 `src/themes.generated.ts`를 만든다. 용어는 `.forge/CONTEXT.md` 용어집을 따른다.
- **업데이트**: 설정 창 수동 확인만 한다(시작 시 자동 확인 없음). `check_update`가 찾은 업데이트만 `install_update`가 설치한다. UI는 `src/updateSection.ts`.
- 초기 로드 JS는 `scripts/check-initial-size.mjs`의 상한(바이트)을 넘기면 안 된다. 무거운 모듈(mermaid 등)은 `import()`로 지연 로드한다.

## 배포

사용자가 "배포해줘"라고 하면 로컬 `release.sh`가 아니라 **GitHub Actions(`release.yml`)로 배포**한다. 공개는 되돌릴 수 없으므로 아래 1~3을 건너뛰지 않는다.

1. **버전을 정한다.** `git tag`의 마지막 태그와 현재 version을 확인하고, 사용자에게 다음 버전(패치/마이너)을 물어 정한다. 이미 태그가 있는 버전으로는 배포할 수 없다.
2. **사전 점검을 한다.**
   - `gh secret list`에 `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, `TAP_GITHUB_TOKEN`이 모두 있는지 본다. 없으면 배포하지 말고 `DEPLOY.md`의 등록 방법을 안내한다. 개인 키 내용은 읽거나 출력하지 않는다.
   - **Homebrew tap**: `gh repo view gyuha/homebrew-tap`으로 저장소가 있는지, `Casks/markview.rb`가 있는지 본다. `TAP_GITHUB_TOKEN`은 이 저장소에 push할 수 있어야 한다(Contents: write). 확인할 수 없는 것은 확인했다고 말하지 않는다.
   - 작업 트리가 깨끗하고 `main`이 `origin/main`과 같아질 수 있는지 본다. 커밋하지 않을 파일(예: `.forge/config.json`)은 올리지 않는다.
3. **실행 전에 사용자에게 한 번 확인받는다.** 버전, push할 커밋 수, "GitHub 릴리스 공개 + tap 갱신은 되돌릴 수 없음"을 보여 준다.
4. **버전을 올린다.** `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`의 `markview` 항목을 같은 값으로 바꾸고 커밋한 뒤 `origin/main`에 push한다.
5. **워크플로를 실행한다.** `gh workflow run release.yml --ref main` 후 `gh run list --workflow release.yml --limit 1`로 run id를 얻어 `gh run watch <id> --exit-status`로 끝까지 지켜본다(= `task release:ci`와 같은 동작, 단 `task`의 대화형 prompt 없이).
6. **결과를 확인한다.** `gh release view v<버전>`이 초안이 아니고 자산 4개(`.dmg`, `.app.tar.gz`, `.app.tar.gz.sig`, `latest.json`)가 있는지, tap의 `Casks/markview.rb`가 새 버전인지 확인해 보고한다. 실패하면 로그의 원인을 그대로 보고한다. tap 갱신만 실패했다면 릴리스는 이미 공개된 상태이므로 되돌리지 않고 `node scripts/update-tap.mjs <버전>`을 안내한다.

서명 키는 `~/.tauri/markview.key`(저장소에 넣지 않음)이고 공개 키는 `tauri.conf.json`의 `plugins.updater.pubkey`에 있다. 흐름만 시험하려면 `task release:dry`(빌드·GitHub·tap을 건드리지 않음). 이 워크플로는 러너에서 처음 실행하면 검증되지 않은 부분이 있을 수 있으니 첫 실행은 지켜본다. 자세한 내용은 `DEPLOY.md`.

## forge

`.forge/`는 forge 워크플로 상태다(`adr/` 설계 결정, `CONTEXT.md` 용어집, `loop.md` 목표 루프). 설계를 바꾸기 전에 관련 ADR을 확인한다.

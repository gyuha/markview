# 배포

markview의 새 버전을 GitHub 릴리스로 공개하고, Homebrew tap의 Cask도 새 버전으로 바꾸는 방법입니다. 앱을 만드는 사람을 위한 문서이고, 사용하는 사람은 [README](README.md)만 보면 됩니다.

버전을 올리고 push한 뒤 `task release`(또는 `pnpm release`) 한 번이면 서명 빌드 → 비공개 초안 업로드(DMG·업데이트 파일·`latest.json`) → 공개(태그 생성) → tap 갱신까지 이어집니다. 공개는 되돌릴 수 없습니다.

## GitHub Actions로 배포

내 Mac 대신 GitHub 러너(`macos-latest`)가 빌드·공개하려면 `task release:ci`(= Actions 탭 → release → Run workflow)를 씁니다. 같은 `scripts/release.sh`를 `SKIP_BUILD=1`로 불러 업로드·공개·tap 갱신을 합니다. 처음 한 번 저장소 **Settings → Secrets and variables → Actions**에 세 개를 등록하세요.

| Secret | 값 |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | `~/.tauri/markview.key` 파일의 내용 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 키 비밀번호(비밀번호 없이 만들었으면 빈 값) |
| `TAP_GITHUB_TOKEN` | `gyuha/homebrew-tap`에 push할 수 있는 토큰(Contents: write) |

워크플로는 러너에서 실제로 돌려 보기 전에는 검증되지 않았습니다. 첫 실행은 `gh run watch`로 지켜보세요.

## 업데이트 서명 키 (처음 한 번)

앱 안 업데이트(설정 → 환경)는 서명된 파일만 받습니다. 서명 키는 `~/.tauri/markview.key`이고, 공개 키는 `src-tauri/tauri.conf.json`의 `plugins.updater.pubkey`에 들어 있습니다. 새로 만들려면:

```sh
pnpm tauri signer generate -w ~/.tauri/markview.key
```

공개 키(`markview.key.pub`)를 `tauri.conf.json`에 넣으세요. **비공개 키를 잃으면 이미 설치된 앱은 새 키로 서명된 업데이트를 받지 못합니다** — 안전한 곳에 백업하고 저장소에는 넣지 마세요. `release.sh`는 `TAURI_SIGNING_PRIVATE_KEY`(경로 또는 내용)가 없으면 이 파일을 쓰고, 둘 다 없으면 빌드 전에 멈춥니다. 비밀번호는 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`입니다.

`latest.json`은 릴리스에 올라가는 업데이트 안내 파일이고, 앱은 `https://github.com/gyuha/markview/releases/latest/download/latest.json`을 봅니다. 그래서 공개하기 **전에** 올립니다. 업데이트 기능이 들어가기 전 버전(0.3.0 이하)은 스스로 업데이트할 수 없어 한 번은 직접 설치(또는 `brew upgrade`)해야 합니다.

## 배포 순서

1. `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`(과 `Cargo.lock`), `package.json`의 `version`을 같은 값으로 올리고 커밋·push합니다. `main` 브랜치이고 `origin/main`과 같아야 합니다.
2. `task release`를 실행합니다(= `scripts/release.sh publish`, `gh` 로그인 필요). 공개 전 확인을 묻습니다.
3. 끝나면 `brew upgrade --cask markview`로 새 버전이 받아지는지 확인합니다.

```
버전 올리기 → push → task release → 서명 빌드 → 초안 업로드(+latest.json) → 공개(태그) → tap 갱신
                                                                    ↓ 실패해도 공개는 유지
                                                              종료 코드 4 + 재실행 안내
```

## tap 갱신이 실패했을 때

릴리스는 이미 공개된 뒤라 되돌리지 않습니다. 원인을 확인하고 tap만 다시 갱신하세요. 이미 반영돼 있으면 아무것도 바꾸지 않습니다.

```sh
node scripts/update-tap.mjs <버전>   # 예: node scripts/update-tap.mjs 0.2.3
```

`update-tap.mjs`는 공개 URL에서 DMG를 받아 GitHub가 준 sha256과 대조한 뒤, 이 저장소의 최신 릴리스일 때만 `gyuha/homebrew-tap`의 `Casks/markview.rb`를 갱신해 push합니다(Cask 생성은 `scripts/update-homebrew-cask.mjs`).

## 시험

실제 빌드·릴리스·push 없이 흐름만 확인하려면 `task release:dry`(= `DRY_RUN=1 VERSION_OVERRIDE=9.9.9 bash scripts/release.sh publish`)를 실행합니다. 서명 키도 필요 없습니다. 스크립트 테스트는 `pnpm test:scripts`입니다.

# 배포

markview의 새 버전을 GitHub 릴리스로 공개하고, Homebrew tap의 Cask도 새 버전으로 바꾸는 방법입니다. 앱을 만드는 사람을 위한 문서이고, 사용하는 사람은 [README](README.md)만 보면 됩니다.

버전을 올리고 push한 뒤 `pnpm release` 한 번이면 DMG 빌드 → 비공개 초안 업로드 → 공개(태그 생성) → tap 갱신까지 이어집니다. 공개는 되돌릴 수 없습니다.

## 배포 순서

1. `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`(과 `Cargo.lock`), `package.json`의 `version`을 같은 값으로 올리고 커밋·push합니다. `main` 브랜치이고 `origin/main`과 같아야 합니다.
2. `pnpm release`를 실행합니다(`scripts/release.sh publish`, `gh` 로그인 필요).
3. 끝나면 `brew upgrade --cask markview`로 새 버전이 받아지는지 확인합니다.

```
버전 올리기 → push → pnpm release → DMG 빌드 → 초안 업로드 → 공개(태그) → tap 갱신
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

실제 빌드·릴리스·push 없이 흐름만 확인하려면 `DRY_RUN=1 VERSION_OVERRIDE=9.9.9 bash scripts/release.sh publish`를 실행합니다. 스크립트 테스트는 `pnpm test:scripts`입니다.

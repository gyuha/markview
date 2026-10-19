---
author: gyuha
decided: 2026-10-20 12:00
---
# 앱 안 업데이트는 Rust가 맡고, 웹뷰에는 updater 권한을 주지 않는다

설정 창(환경 탭)에서 새로 설치하지 않고 업데이트할 수 있게 하면서(이슈 #3), Tauri updater 플러그인을 **Rust에서만** 쓰고 웹뷰에는 `updater`·`process`·`dialog` 권한을 열지 않았다. 웹뷰 권한 최소화 원칙(`261010-234732-webview-minimal-capabilities.md`)을 그대로 따른다.

## 결정
- **Rust 커맨드 `check_update`·`install_update`.** 확인은 새 버전 정보(`version`·`notes`·`date`)만 돌려주고, 설치는 Rust가 받아 설치하며 `update-progress` 이벤트(`{downloaded, total}`)로 진행률을 알린 뒤 직접 재시작한다. 스크립트가 임의 주소의 파일을 설치시킬 길이 없다.
- **서명 검증.** 업데이트 파일은 minisign 서명 키(`~/.tauri/markview.key`)로 서명하고 공개 키는 `tauri.conf.json`에 둔다. 엔드포인트는 `releases/latest/download/latest.json` 하나다.
- **확인은 설정 창에서 사람이 누를 때만.** 시작·창 열기로 네트워크 확인을 하지 않는다(V08이 지킨다).
- **설치 전 저장하지 않은 문서가 있으면 확인 대화상자.** 설치 뒤 재시작으로 편집 내용이 사라지는 것을 막는다.
- **`createUpdaterArtifacts`는 릴리스 빌드에서만 `--config`로 켠다.** 평소 `pnpm tauri build`는 키 없이 된다. `scripts/release.sh`가 키를 빌드 전에 확인하고, `latest.json`을 **공개하기 전에** 올린다.

## 버린 대안
- **JS `plugin-updater` + `plugin-process`** — 코드는 짧지만 웹뷰가 설치·재시작 권한을 갖는다.
- **시작할 때 자동 확인** — 이슈가 설정 창에서 하라고 했고, 네트워크 호출이 늘어난다. 필요하면 나중에 추가한다.

## 감수하는 결과
- 업데이트가 들어가기 전 버전(0.3.0 이하)은 스스로 업데이트할 수 없어 한 번은 직접 설치해야 한다.
- 서명 키를 잃으면 설치된 앱이 새 업데이트를 받지 못한다. 백업이 필요하다.
- 실제 다운로드·설치·재시작은 하네스로 재현하지 못한다. 릴리스 두 개를 공개해 사람이 확인한다(`.forge/uat/update.md`).

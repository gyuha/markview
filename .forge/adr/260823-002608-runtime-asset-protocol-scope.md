---
author: gyuha
decided: 2026-08-23 00:26
---
# assetProtocol scope는 정적 선언이 아니라 런타임에 문서 단위로 허용한다

`tauri.conf.json`의 `app.security.assetProtocol.scope`를 **빈 배열로 두고**, Rust의 `read_markdown` 커맨드가 검증을 통과한 문서의 **부모 디렉터리만** 그 시점에 `app.asset_protocol_scope().allow_directory(dir, false)`로 허용한다.

설정 파일만 보면 scope가 비어 있어 "이미지가 로드될 수 없는 구성"으로 보이기 때문에 기록한다. 드래그드롭으로 들어오는 경로는 **사전에 알 수 없는 임의 경로**여서 정적 allowlist와 원리적으로 맞지 않는다. 정적 선언으로 해결하려면 `$HOME/**` 같은 넓은 scope를 열어야 하는데, 그것은 마크다운 문서 하나를 열기 위해 홈 전체의 파일을 asset protocol에 노출하는 일이다. 런타임 허용은 "지금 열린 문서의 폴더"로 권한을 좁힌다.

## 함께 결정한 것
스캐폴드 기본값이던 `withGlobalTauri: true`를 `false`로 껐다. 전역 `window.__TAURI__` 노출은 raw HTML을 허용한 결정(`260822-222214-raw-html-sanitized.md`)의 위협 모델을 그대로 키우는 지점이고, npm API import만 쓰는 구성에서 열어둘 이유가 없다.

## 감수하는 결과
- 권한이 **실행 경로에 의존한다.** 설정 파일을 읽어 "무엇에 접근 가능한가"를 정적으로 판단할 수 없고, `read_markdown`의 코드를 봐야 한다.
- 허용은 누적된다. 문서를 여러 개 열면 그만큼의 부모 디렉터리가 세션 동안 허용 상태로 남는다. 앱을 재시작하면 초기화된다.
- `assetProtocol.enable: true`를 켜면 Cargo의 `tauri` 의존성에 `protocol-asset` 피처가 필요하다 — 없으면 빌드가 실패한다.

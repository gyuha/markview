---
author: gyuha
decided: 2026-09-02 10:55
---
# 클립보드 쓰기는 웹 API가 아니라 Tauri 플러그인으로 한다

코드블록 복사 버튼의 클립보드 쓰기에 `navigator.clipboard.writeText`를 쓰지 않고 `@tauri-apps/plugin-clipboard-manager`(+ Rust `tauri-plugin-clipboard-manager` + capability 권한)를 쓴다.

## 맥락

`navigator.clipboard`는 **secure context에서만** 존재한다. macOS 프로덕션 빌드는 `tauri://localhost` custom scheme으로 로드되고, WKWebView는 custom scheme을 secure context로 등록하지 않는다 — `wry-0.55.1/src/wkwebview/`에도 그런 등록 코드가 없다(쿠키의 `secure` 처리만 있다).

**함정은 dev와 프로덕션이 다르다는 점이다.** `pnpm tauri dev`는 `http://localhost:1420`을 로드하므로 secure context이고 `navigator.clipboard`가 정상 동작한다. 그래서 웹 API로 구현하면 **개발 중에는 통과하고 배포한 앱에서만 조용히 죽는다.** 이 프로젝트에는 CI가 없어 배포물 검증이 사람 손에 달려 있으므로, 그 종류의 버그는 사용자에게 먼저 도달한다.

## 감수하는 결과

- 의존성이 세 곳 늘어난다 — npm 패키지, Rust crate, capability 권한. 권한을 빠뜨리면 런타임에 거부되므로 셋이 한 묶음이다.
- 번들이 수 KB 늘어난다.
- 하네스에서는 오히려 이득이다: `harness/mock-tauri.js`가 이미 `invoke`를 가로채 기록하므로, 복사 클릭이 올바른 내용으로 `plugin:clipboard-manager|write_text`를 호출했는지 브라우저에서 실측할 수 있다. 웹 API였다면 브라우저에서만 되고 실제 앱에서는 못 재는 비대칭이 남는다.

## 되돌리려면

"플러그인이 무거우니 웹 API로 바꾸자"는 제안이 나오면, **dev에서의 통과는 증거가 아니다.** 반드시 `pnpm tauri build`로 만든 `.app`/`.dmg`에서 확인해야 한다. WKWebView가 custom scheme을 secure context로 승격하거나 Tauri가 `http://localhost` 기반 로딩을 기본으로 바꾼 뒤에야 이 결정을 다시 볼 값어치가 있다.

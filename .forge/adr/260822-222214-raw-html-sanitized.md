---
author: gyuha
decided: 2026-08-22 22:22
---
# raw HTML은 허용하되 DOMPurify로 sanitize한다

markdown-it을 `html: true`로 두어 마크다운 안의 raw HTML을 해석하고, DOM에 주입하기 전에 DOMPurify로 sanitize한다.

두 요구가 정면으로 충돌하기 때문에 기록한다. 한쪽에서는 실제 마크다운 문서에 `<br>`, `<details>`, `<img align>`이 흔해서 `html: false`로 두면 문서가 원본과 다르게 그려지고, 마크다운 뷰어의 존재 이유가 훼손된다. 다른 한쪽에서는 Tauri webview에 IPC가 노출되어 있어 무방비로 허용하면 악성 `.md` 파일 하나로 실행된 스크립트가 read_markdown 커맨드를 호출해 임의 파일을 읽을 수 있다 — 마크다운은 남이 준 파일을 여는 것이 정상인 포맷이므로 이론적 위협이 아니다. sanitize는 의존성 하나로 두 요구를 동시에 만족시키는 유일한 지점이다.

## 감수하는 결과
- DOMPurify 의존성이 추가된다. 직접 화이트리스트를 짜는 대안은 sanitize를 자산하는 일이라 택하지 않았다.
- sanitize가 지우는 태그 때문에 원본과 다르게 보이는 문서가 있을 수 있다. 그 경우 허용 목록을 조정하되 script/on* 핸들러는 되돌리지 않는다.

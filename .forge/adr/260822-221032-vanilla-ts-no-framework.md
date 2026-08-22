---
author: gyuha
decided: 2026-08-22 22:10
---
# 프론트엔드는 프레임워크 없이 vanilla TS + Vite로 간다

React/Svelte/Solid를 쓰지 않고 vanilla TypeScript + Vite로 구성한다. "왜 프레임워크가 없나"는 나중에 반드시 나올 질문이므로 이유를 남긴다.

이 앱의 UI 자체는 탭바 하나와 스크롤 컨테이너 하나로 끝난다. 실제 복잡도는 전부 파싱 결과 HTML을 DOM에 주입한 뒤 그 DOM을 후처리하는 일 — mermaid SVG 렌더, 코드 하이라이팅, 테마 전환 시 재렌더 — 에 있고, VDOM은 이 영역에서 도움이 아니라 마찰이다 (React라면 dangerouslySetInnerHTML + useEffect 조합에서 StrictMode 이중 실행과 재렌더 시 렌더된 SVG 소실을 직접 다뤄야 한다).

## 감수하는 결과
- 탭 상태, 키보드 단축키, 설정 패널이 늘어나면 손으로 쓴 DOM 조작 코드가 지저분해진다. 그 지점이 오면 프레임워크 도입을 재검토하되, 프로토타입 검증이 끝난 뒤에 한다.
- 이 코드가 v1의 씨앗이 될 경우 재작성 비용이 발생할 수 있음을 알고 택했다.

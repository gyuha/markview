---
author: gyuha
decided: 2026-08-24 22:48
---
# 시스템 모드에서는 네이티브 테마를 강제하지 않는다

선택 테마가 `system`일 때는 Tauri의 `setTheme`에 `null`을 넘겨 강제를 풀고, `light`/`dark`일 때만 구체값을 넘긴다. `applyChrome`은 실효 테마만 받는 것으로 충분하지 않고 **선택 테마도 받아야** 한다 — 중복처럼 보이지만 그렇지 않다.

이유는 `setTheme`이 창 하나가 아니라 **애플리케이션 전체의 appearance를 고정**하기 때문이다. tao 구현(`tao-0.35.3/src/platform_impl/macos/window.rs:384`)은 `[NSApp setAppearance: <고정 appearance>]`를 호출하고, `None`일 때만 `nil`을 넣어 시스템 추종으로 되돌린다. 고정된 appearance는 WKWebView로 전파되므로, 그 뒤 webview의 `prefers-color-scheme`은 OS 설정이 아니라 **우리가 고정한 값**을 보고한다.

즉 실효 테마를 유도하는 입력(`matchMedia`)을 우리 자신이 오염시킨다. 처음 구현은 항상 구체값을 넘겼고, 그 결과 라이트를 한 번 고른 뒤 시스템으로 바꾸면 `effectiveOf("system")`이 고정된 "light"를 읽어 다시 라이트로 고정되는 순환에 갇혔다. 시스템 모드에서 macOS 외관을 바꿔도 `change` 이벤트가 뜨지 않아 따라오지 않는 것도 같은 원인이다.

**순서도 결정의 일부다.** 강제를 풀기 전에 `matchMedia`를 읽으면 여전히 낡은 값을 읽는다. 그래서 네이티브 테마 적용을 먼저 `await`하고 그 다음에 실효 테마를 산출한다 — `applyTheme`이 async가 되는 비용을 감수한다.

## 버린 대안
- **`setTheme`을 아예 호출하지 않기** — 버그는 사라지지만, OS가 라이트인데 다크를 고르면 타이틀바만 밝게 남아 본문과 어긋난다. 애초에 `setTheme`을 넣은 이유가 그것이었다.
- **OS 값을 Rust에서 직접 읽기** (`NSUserDefaults`의 `AppleInterfaceStyle`) — 강제 여부와 무관하게 결정적이지만, `matchMedia`가 죽으므로 OS 변경 감지도 Rust 알림으로 새로 만들어야 하고, "실효 테마를 누가 정하는가"의 권한이 프론트엔드에서 Rust로 넘어간다. 프론트엔드가 테마를 유도한다는 기존 결정과 어긋난다.

## 감수하는 결과
- `applyChrome`의 인자가 둘이라 중복처럼 보인다. 하나로 "단순화"하면 이 버그가 그대로 부활한다. 그래서 `harness/theme.ts`가 호출 형태(system → `null`, light/dark → 구체값)와 호출 순서를 기계적으로 단정한다.
- `applyTheme`이 async가 되어 호출부가 `void applyTheme()` 형태가 된다.
- 시스템 모드에서는 네이티브 타이틀바가 OS를 따르고 본문도 OS를 따르므로 어긋나지 않는다. 어긋남은 light/dark를 명시적으로 고른 경우에만 발생하고, 그때는 우리가 타이틀바까지 맞춘다.

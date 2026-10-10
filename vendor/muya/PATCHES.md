# Muya 이식본 패치 목록

`vendor/muya/src`는 MarkText 고정 커밋(`UPSTREAM` 참고)의 `packages/muya/src`와 바이트 단위로 같아야 한다.
바꾼 파일은 반드시 아래에 `- src/<경로> — <사유>` 형식으로 적는다. 변경 줄 합계는 300줄 이하로 유지한다
(`node scripts/check-muya-vendor.mjs`가 대조한다). ADR: `.forge/adr/261010-202536-edit-mode-vendored-marktext-muya.md`

- src/utils/image.ts — Tauri(WKWebView, `tauri://localhost`)는 `file://` 이미지를 불러오지 못한다. `localPathToFileUrl`이 앱이 주입한 `window.MUYA_LOCAL_IMAGE_URL`(URL 인코딩된 절대 경로 → asset protocol URL)을 먼저 쓰게 했다. 주입이 없으면 원래 동작 그대로. 타입 선언은 앱 쪽(`src/vite-env.d.ts`)에 둔다. (task 18, marktext-editor-2of6)
- src/utils/prism/loadLanguage.ts — Prism 언어 문법을 `../../../node_modules`(업스트림 모노레포의 `packages/muya/node_modules`)에서 동적으로 불러온다. vendor 위치에서는 그 경로가 `vendor/muya/node_modules`(없음)가 되어 js 외 언어 하이라이트가 "Unknown variable dynamic import"로 깨진다. 저장소 루트 `node_modules`를 가리키도록 상대 경로 깊이만 바꿨다. (task 18, marktext-editor-2of6)

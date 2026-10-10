---
author: gyuha
decided: 2026-10-10 20:25
---
# 편집 전용 모드는 MarkText의 Muya 엔진을 소스째 이식해 쓴다

툴바의 첫 번째 모드(연필, F1 편집 전용)를 CodeMirror 원문 편집기에서 **MarkText의 편집 엔진 Muya**로 바꾼다. 엔진은 `marktext/marktext`의 `packages/muya/src`를 **고정 커밋 `34ea9931a34ded1f3d462f0821a12e6eb64cd180`** 그대로 `vendor/muya/src`에 복사해 이 앱의 Vite로 빌드한다. 분할(F2)은 지금처럼 CodeMirror + 프리뷰, 보기(F3)는 프리뷰로 남는다.

요구가 "MarkText의 편집 기능을 소스를 참고해 최대한 그대로"였기 때문에 **같음**을 최우선으로 두었다. Muya는 TypeScript 약 5.3만 행이라 다시 쓰면 수주가 걸리고 결과는 원본보다 덜 같다. 그래서 재작성은 처음부터 배제했다.

## 버린 대안
- **npm `@muyajs/core@0.2.0`** — 가장 단순하지만 2026-05 빌드라 MarkText 최신보다 5개월 뒤처진다. MarkText 데스크톱이 실제로 쓰는 플러그인 2개(`TableChessboard`, `ImagePathPicker`)가 없고 그 사이의 수정도 빠진다. "그대로"에 못 미친다.
- **처음부터 재작성** — 위 이유로 배제.

## 함께 정한 것
- **이식본은 손대지 않는 것이 원칙이다.** 바꿔야 하면(Tauri asset protocol용 이미지 경로, WebKit 전용 결함 등) `vendor/muya/PATCHES.md`에 파일과 사유를 적고, 변경 줄 합계를 300줄 이하로 유지한다. `scripts/check-muya-vendor.mjs`가 고정 커밋과 바이트 단위로 대조한다.
- **Muya는 CodeMirror와 다른 호스트에 붙는다.** 편집 모드에서는 `.editor-host`(CodeMirror)가 숨겨진다.
- **재직렬화를 받아들인다.** MarkText처럼 첫 편집이 일어나면 문서 전체가 Muya 규칙으로 다시 쓰인다(리스트 기호, 표 정렬 등). 대신 편집 없이 모드만 오가면 원문 바이트가 그대로여야 한다.
- **편집 동작의 기본값은 MarkText 기본 설정(`static/preference.json`)을 따른다.** 다만 색은 MarkText 테마가 아니라 이 앱의 GitHub 팔레트를 쓴다.
- **Muya는 편집 모드에 처음 들어갈 때 동적으로 불러온다.** 이 앱은 뷰어가 본업이므로, 보기로 열 때 내려받는 JS는 이식 전 대비 +5%를 넘지 않는다.
- 함께 가져온 것: MarkText macOS 단축키(format·paragraph·edit 42개), 찾기/바꾸기 검색창, 이미지 붙여넣기·드롭을 문서 옆 `assets/`에 저장하는 기능.
- 가져오지 않은 것: 소스코드 모드, 타자기·집중 모드, 사이드바, 내보내기·인쇄, 맞춤법 검사, 설정 화면(이것들은 Electron 앱 쪽 기능이다).

## 감수하는 결과
- 의존성이 20개 안팎 늘고, mermaid를 12로 올려 프리뷰와 편집기가 한 벌을 같이 쓴다.
- 업스트림 갱신은 수동이다. 커밋을 올리면 `UPSTREAM`과 판정 스크립트의 고정 커밋을 함께 바꾸고 PATCHES를 다시 적용해야 한다.
- Muya는 Electron(Chromium)에서 개발된 엔진이다. Tauri의 WKWebView에서는 WebKit 결함이 드러날 수 있어 하네스를 Chromium과 WebKit 양쪽에서 돌린다. 한글 IME 조합 입력과 네이티브 메뉴의 단축키 가로채기는 하네스가 재현하지 못하므로 실제 창 확인이 남는다(하네스 ADR `260824-231810`과 같은 한계).

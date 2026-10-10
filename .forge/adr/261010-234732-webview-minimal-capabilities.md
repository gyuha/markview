---
author: gyuha
decided: 2026-10-10 23:47
---
# 웹뷰 스크립트에는 대화상자·클립보드 읽기 권한을 주지 않는다

편집 모드에 이미지 저장·일반 텍스트 붙여넣기를 넣으면서, 프런트엔드가 쓰기 쉬운 JS 플러그인(`@tauri-apps/plugin-dialog`, 클립보드 `read-text`)을 쓰는 대신 **Rust가 직접 처리하고 결과만 웹뷰에 넘기는** 방식을 택했다. capability(`src-tauri/capabilities/default.json`)에는 `clipboard-manager:allow-write-text`만 남아 있다.

이 앱은 raw HTML을 허용하고 DOMPurify로 거른다(`260822-222214-raw-html-sanitized.md`). 그 걸러내기가 뚫리는 경우를 가정해, **스크립트가 가진 권한 자체를 줄인다.** 설정 파일만 보면 JS API로 더 간단히 될 것처럼 보이므로 이유를 남긴다.

## 결정
- **파일 선택은 Rust 커맨드 `pick_image`.** Rust가 대화상자를 띄우고 고른 파일을 바로 문서 옆 `assets/`로 복사해 상대 경로만 돌려준다. JS 대화상자 API는 고른 폴더를 asset protocol 범위에 **재귀로** 열어 버린다 — 스크립트가 폴더 선택을 유도하면 홈 전체가 읽힌다.
- **일반 텍스트 붙여넣기(⇧⌘V)는 메뉴 가속기.** MarkText도 그렇다. 사용자가 키를 누를 때만 Rust가 클립보드를 읽어 이벤트로 넘긴다. 스크립트는 메뉴 이벤트를 일으킬 수 없어서, 클립보드 읽기 권한 없이도 되고 조용히 읽는 길이 없다.
- **이미지 복사는 사용자가 실제로 드롭한 경로만.** Rust가 창 이벤트(`DragDrop::Drop`)에서 경로를 기록하고 `copy_asset`은 그 목록에 있는 경로만 받는다. 스크립트가 임의 경로를 지어낼 수 없다.
- **쓰기는 연 문서의 폴더 밑 `assets/` 하나뿐.** 연 문서 확인 → 실제 폴더 확인(링크로 된 assets 거부) → 임시 파일은 `create_new`(O_EXCL)로 열어 심어 둔 심볼릭 링크를 따라가지 않는다. 같은 패턴이던 기존 저장(`save_document`)도 같이 고쳤다.
- 검증은 `src-tauri/src/assets.rs`와 `lib.rs`의 Rust 단위 테스트가 지킨다(경로 탈출·링크·드롭 게이트·링크 덮어쓰기).

## 버린 대안
- **JS `plugin-dialog` + `clipboard read-text` 권한** — 코드는 가장 짧지만 위 두 공격 경로가 열린다. 보안 리뷰에서 실측으로 재현됐다.
- **경로를 JS가 넘기는 `copy_asset`** — 이미지 이름의 링크가 `~/.ssh/id_rsa`를 가리키면 그 내용이 `assets/`에 복사돼 asset protocol로 읽을 수 있다.

## 감수하는 결과
- Rust 쪽 코드가 늘고, 대화상자·클립보드 동작을 하네스로 재현하지 못한다(모킹 IPC까지만). 실제 창 확인이 필요하다.
- ⇧⌘V가 메뉴 가속기라 편집 모드에서도 키 이벤트가 웹뷰에 오지 않는다. 키맵 표(`src/muyaKeymap.ts`)에는 있지만 웹뷰 동작은 비어 있다.
- 업스트림 Muya의 이미지 저장 실패 동작(거부되면 data URL이 원문에 남음)은 그대로다. 수 MB면 `read_markdown`의 5MB 상한 때문에 다시 열 수 없게 될 수 있다.

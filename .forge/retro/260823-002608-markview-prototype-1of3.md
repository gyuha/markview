# 2026-08-22 — Tauri 스캐폴드 + 파일 읽기 + 마크다운 렌더 파이프라인

## 계획 vs 실제
- 계획대로 된 것: 6개 슬라이스 전부 착지. 스캐폴드 → Rust 커맨드 → markdown-it 파이프라인 → 이미지 → 링크 순서가 그대로 통했다. 빌드·컴파일 검사 3개 통과.
- 차이: 현재 디렉터리가 비어 있지 않아 임시 디렉터리에 스캐폴드 후 복사해야 했다. `assetProtocol.enable`을 켜면서 Cargo에 `protocol-asset` 피처가 필요해 첫 `cargo check`가 실패했다. `markdown-it-anchor` v9는 `permalink: false`를 받지 않고, `markdown-it-front-matter`는 타입 선언을 제공해 `@ts-expect-error`가 불필요했다.

## 학습
- 다음엔 다르게:
  - **셸 cwd가 남는 것을 전제로 절대 경로를 쓴다.** 백그라운드가 아닌 `cd src-tauri && cargo check`의 cwd가 이후 호출까지 유지되어, 뷰어 CSS가 `src-tauri/src/`로, 픽스처가 `src-tauri/fixtures/`로 쓰였다. **그런데도 `pnpm build`는 통과했다** — 루트에 스캐폴드 원본 `styles.css`가 남아 그 자리를 채우고 있었기 때문이다. **빌드 통과는 파일 배치의 정확성을 보장하지 않는다.** 파일을 옮기거나 만든 뒤에는 트리를 직접 확인한다.
  - **파이프 뒤에서 종료 코드를 읽지 않는다.** `cargo check 2>&1 | tail -40`의 exit는 `tail`의 것이어서 실패를 통과로 오독했다. 로그는 파일로 리다이렉트하고 `$?`를 따로 읽는다.
  - **자산을 손으로 지어내지 않는다.** base64 문자열로 만든 `logo.png`가 유효한 PNG가 아니어서 브라우저가 디코딩을 거부했다. 이미지·바이너리는 생성 코드(zlib/CRC 직접 계산 또는 PIL)로 만들고 즉시 검증한다.
  - 한글 헤딩 앵커를 버그로 오진해 불필요한 3중 폴백을 넣었다. `markdown-it-anchor`의 id와 markdown-it의 href는 **둘 다 퍼센트 인코딩**이라 일치한다. 추측 대신 실제 출력을 먼저 본다.

## 문서 갱신
- CONTEXT.md 승급: 없음
- 추가된 ADR: assetProtocol 런타임 scope (아래 3of3·전체 세션 공통 결정으로 별도 ADR 작성)

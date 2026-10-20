<!-- forge-slug: pele-muya-mermaid -->
<!-- task: 6 -->
<!-- priority: medium -->
<!-- tdd: off -->
# 편집 모드(Muya) mermaid 렌더를 pele 우선 + mermaid 폴백으로 교체

## Goal / Non-goals
- Goal: `vendor/muya/src/utils/diagram/render.ts`의 mermaid 분기가 pele로 먼저 그리고 실패 시 기존 mermaid 경로로 폴백하게 한다. 패치는 `vendor/muya/PATCHES.md`에 사유와 함께 기록하고 변경 줄 합계 ≤300을 지킨다. `scripts/pele-e2e.mjs`에 P5·P6(Muya)를 추가한다. 다크/라이트에 따른 색은 기존 `mermaidTheme` 옵션을 입력으로 쓴다.
- Non-goals: 미리보기 코드 변경(앞 작업 범위), mermaid 의존성 제거, vendor 다른 파일 수정, 판정 기준 파일 수정.

## Source of truth
- Glossary terms: none
- Related ADRs: .forge/adr/261010-202536-edit-mode-vendored-marktext-muya.md
- Definition of Done: loop.md의 C1–C4 전부 통과(특히 C2 P5·P6, C3의 check-muya-vendor.mjs와 muya 하네스 48/48 ×2엔진).

## Work slices
- [ ] S1. `vendor/muya/src/utils/diagram/render.ts`의 mermaid 분기를 pele 우선·mermaid 폴백으로 패치하고 PATCHES.md에 기록 — 완료 기준: `node scripts/check-muya-vendor.mjs` 종료코드 0
- [ ] S2. `scripts/pele-e2e.mjs`에 P5·P6 추가, pele 경로를 껐을 때 P5가 실패함을 확인 — 완료 기준: `node scripts/pele-e2e.mjs` 종료코드 0 (depends: S1)
- [ ] S3. 회귀 확인 — 완료 기준: `node harness/run.mjs muya` 종료코드 0, `pnpm build` 종료코드 0 (depends: S2)

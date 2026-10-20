# RUN — 편집 모드(Muya) mermaid 렌더를 pele 우선 + mermaid 폴백으로 교체

직접 실행(워크플로우 없이).

## 슬라이스 결과
- S1 vendor/muya render.ts 패치 + PATCHES.md — ✅ as planned (변경 23줄, 예산 300). `loadRenderer`보다 앞에서 pele를 시도해야 mermaid 번들이 폴백 때만 로드됨
- S2 pele-e2e P5·P6 — ✅ as planned (P6가 pele 스텁 상태에서 `svg.pele` 아님을 단정 → 레드→그린 증거 겸함)
- S3 회귀 — ✅ as planned

## 계획 외 변경
- src/styles.css에 `.pele { --pele-*: var(앱 변수) }` 추가: Muya SVG에는 인라인 팔레트가 없어 앱 테마를 CSS 변수로 대 줌(계획 S1에 암묵적으로 포함된 테마 연결, 승인된 범위 내).

## DoD baseline → after
- C2 P5·P6: 없음 → PASS ×2엔진 · P1–P4 유지
- C3 muya 하네스 48/48 ×2엔진 → 48/48 · check-muya-vendor 0 → 0(23줄) · build 0 → 0 · test:scripts 36 → 36 · regression/colortheme 0 → 0
- C4 판정 기준 diff 없음 → 없음

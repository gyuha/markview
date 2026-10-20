# RUN — 미리보기 mermaid 렌더를 pele 우선 + mermaid 폴백으로 교체

직접 실행(워크플로우 없이, 규모가 작아서).

## 슬라이스 결과
- S1 `pnpm add pele` — ✅ as planned (pele ^1.6.0, package.json·pnpm-lock 갱신)
- S2 `src/mermaid.ts` pele 우선·mermaid 지연 폴백 — ✅ as planned. 팔레트는 `palette.mermaid`에서 `--pele-*`로 매핑해 SVG 인라인 style에 주입(캐시 키는 기존 그대로)
- S3 `scripts/pele-e2e.mjs` P1–P4 — ⚠ 계획의 "pele 경로를 껐을 때 P1 실패" 증명은 별도 실행 대신 P3(pele 스텁 → `svg.pele` 아님)으로 갈음. P2 첫 시도는 테스트가 다크 기본 테마를 dracula로 오가정해 실패 → github-dark로 수정
- S4 회귀 — ✅ as planned

## DoD baseline → after
- C1 dependencies.pele: 없음 → 있음, pnpm build exit 0 → 0
- C2 pele-e2e: 스크립트 없음 → P1–P4 PASS (chromium·webkit)
- C3 test:scripts 36 pass → 36 pass · check-muya-vendor 0 → 0 · regression 0 → 0 · colortheme 0 → 0 (colortheme.ts 수정 없이 통과)
- C4 판정 기준 파일 diff 없음 → 없음

## 판단
- mermaid 번들은 폴백 때만 로드(P1에서 요청 0건 확인).

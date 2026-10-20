<!-- forge-slug: pele-preview-mermaid -->
<!-- task: 5 -->
<!-- priority: high -->
<!-- tdd: off -->
# 미리보기 mermaid 렌더를 pele 우선 + mermaid 폴백으로 교체

## Goal / Non-goals
- Goal: `pele`를 의존성에 추가하고 `src/mermaid.ts`가 pele(`render`, 동기)로 먼저 그리게 한다. pele가 던지면 지연 로드한 mermaid로 다시 시도하고, 둘 다 실패하면 기존 실패 배지 경로를 그대로 쓴다. 테마는 `palette`에서 `--pele-*` CSS 변수로 SVG에 인라인 적용해 테마 전환 시 다시 그려진다(기존 colortheme 하네스의 "SVG에 새 테마 파랑 포함" 단정이 수정 없이 통과해야 한다). 새 `scripts/pele-e2e.mjs`를 만들어 P1–P4(미리보기)를 단정한다.
- Non-goals: Muya(편집 모드) 변경, mermaid 의존성 제거, 다른 다이어그램 렌더러, 판정 기준 파일 수정.

## Source of truth
- Glossary terms: none
- Related ADRs: .forge/adr/260822-220748-frontend-markdown-parsing.md
- Definition of Done: loop.md의 C1·C2(P1–P4)·C3·C4를 이 작업 범위에서 모두 통과. 렌더 캐시(`svgCache`)와 실패 배지 동작은 유지. 기존 `palette.mermaid`는 변경하지 않는다(theme-colors.test.mjs가 고정).

## Work slices
- [ ] S1. `pnpm add pele`(1.x)로 의존성 추가 — 완료 기준: package.json dependencies에 pele, `pnpm build` 종료코드 0
- [ ] S2. `src/mermaid.ts`를 pele 우선·mermaid 지연 폴백으로 바꾸고 팔레트→`--pele-*` 인라인 변수 매핑을 둔다 — 완료 기준: P1·P2·P3·P4 로직이 구현되고 mermaid 번들은 폴백 때만 로드된다 (depends: S1)
- [ ] S3. `scripts/pele-e2e.mjs`(Playwright chromium+webkit, Vite dev 서버)에 P1–P4를 작성하고 pele 경로를 껐을 때 P1이 실패함을 확인한다 — 완료 기준: `node scripts/pele-e2e.mjs`가 P1–P4 PASS 종료코드 0, 레드→그린 증거가 run.md에 남음 (depends: S2)
- [ ] S4. 회귀 확인 — 완료 기준: `pnpm test:scripts`, `node harness/run.mjs regression|colortheme` 종료코드 0 (depends: S3)

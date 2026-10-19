# 색상 테마 (원본 데이터)

[TerminalColors](https://terminalcolors.com/)에서 제공하는 Warp용 YAML 테마 112개(2026-10-08 내려받음)다. 앱에 번들되지 않는 **원본 데이터**이고, 앱은 실행 중에 이 파일을 읽지 않는다(ADR `261019-134956`).

빌드 전에 `scripts/gen-themes.mjs`(`pnpm gen-themes`)가 이 YAML을 읽어 `src/themes.generated.ts`를 만든다. 테마마다 `id`(파일 이름)·`name`·`kind`(`light`/`dark`)·`background`·`foreground`·`accent`와 터미널 normal 8색이 들어간다. `src/themeColors.ts`가 이 값에서 본문·UI·편집 모드(Muya)·코드 하이라이트·mermaid의 색을 계산한다.

- `kind`는 YAML의 `details`로 정한다: `lighter` → 라이트용(32개), `darker` → 다크용(80개). 설정 대화상자는 라이트용·다크용 색상 테마를 따로 고르고, 모드(라이트/다크/시스템)가 어느 쪽을 칠할지 정한다.
- 기본 색상 테마는 `github-light`(라이트)·`github-dark`(다크)다.
- 테마를 추가·수정하면 `pnpm gen-themes`를 다시 실행하고 `src/themes.generated.ts`를 함께 커밋한다. 생성 파일이 최신이 아니면 `pnpm test:scripts`(`scripts/gen-themes.test.mjs`)가 실패하고, `node scripts/gen-themes.mjs --check`도 종료코드 1을 낸다.

**라이선스 — 릴리스 전에 반드시 확인한다**: 각 테마의 원저작자와 라이선스는 서로 다를 수 있다. Dracula 공식 팔레트는 MIT이나, 이것이 이 디렉터리의 모든 파일 또는 TerminalColors의 변환 파일에 동일하게 적용된다는 뜻은 아니다. 이 YAML 파일 자체는 앱에 들어가지 않지만 테마의 색 값은 생성된 `themes.generated.ts`로 앱에 들어가므로, 앱을 배포하기 전에 테마별 출처와 재배포 조건을 확인하고 필요한 고지문을 추가해야 한다. 이 점검은 아직 하지 않았다(후속 계획).

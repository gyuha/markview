# run — ⌥+숫자 탭 전환 시 활성 탭을 탭바 가시 영역 안으로 스크롤 (GitHub #10)

## 슬라이스 결과
- S1 harness/tabkeys.ts에 N09~N14 추가(추가만), required-tabkeys.txt에 ID 추가 — ✅ 계획대로 (레드 확인)
- S2 src/main.ts activate()에 활성 탭 버튼 scrollIntoView({block:"nearest", inline:"nearest"}) 추가 — ✅ 계획대로 (그린)
- S3 회귀 — ✅ regression·tabdrag·session·width·colortheme·muya 하네스, pnpm test:scripts, pnpm build 모두 종료코드 0

## DoD baseline → after
- C1 tabkeys: 필수 9개(N00–N08) PASS → 필수 15개 중 15개 PASS (Chromium·WebKit)
- C2 기존 줄 삭제: 0 → 0 (추가만; 이미 통과하는 회귀 가드)
- C3 회귀: 수정 전후 모두 종료코드 0 (회귀 가드)

## 레드 → 그린 증거 (N09)
수정 전 (src/main.ts 미수정):
    FAIL  [N10] 보기 모드: 오른쪽 끝에서 ⌥1을 누르면 화면 밖 첫 탭이 탭바 안으로 들어온다  before=false after=false index=0
    PASS  [N09] 탭바를 좁히면 가로 오버플로가 생긴다(이후 단정의 전제)

수정 후:
    PASS  [N09] 탭바를 좁히면 가로 오버플로가 생긴다(이후 단정의 전제)
    PASS  [N10] 보기 모드: 오른쪽 끝에서 ⌥1을 누르면 화면 밖 첫 탭이 탭바 안으로 들어온다
    PASS  [N11] 보기 모드: 첫 탭에서 ⌥3·⌥9를 누르면 화면 밖 마지막 탭이 탭바 안으로 들어온다
    PASS  [N12] 보기 모드: 일부만 보이는 중간 탭(⌥2)도 탭바 안으로 완전히 들어온다
    PASS  [N13] 분할 모드: ⌥1·⌥3으로 화면 밖 탭이 탭바 안으로 들어온다
    PASS  [N14] 편집 전용 모드: ⌥1·⌥3으로 화면 밖 탭이 탭바 안으로 들어온다
    chromium: 필수 15개 중 PASS 15개 · FAIL 줄 0개
    webkit: 필수 15개 중 PASS 15개 · FAIL 줄 0개

## 분기
- 탭바를 좁혀 오버플로를 만든 하네스 시나리오(탭 3개 + #tabbar 너비 1.5×탭폭)로 검증. 실제 탭 수십 개 환경의 수동 확인은 하지 않음.

// 문서 너비 4단계 — 실제 DOM 조작(설정 대화상자 클릭·키 입력)으로만 구동하고 렌더된 폭으로 판정한다.
// `node harness/run.mjs width` 가 ?files=1 한 페이지로 돌린다. 새로고침을 넘어 유지되는지 보려고
// sessionStorage에 단계(phase)와 지금까지의 결과 줄을 두고 같은 페이지를 세 번 읽는다(A: 조작 → B: 저장값 → C: 잘못된 값).
// 선택자 계약: #settings-button · .settings-close · .settings-tab · [role=radiogroup][aria-label="문서 너비"] [role=radio][data-width-choice]
//              · .markdown-body · .muya-host .mu-container
import { clickMode, muyaOf, tabs, wait } from "./lib-muya";

const out = document.querySelector<HTMLElement>("#out")!;
const lines: string[] = JSON.parse(sessionStorage.getItem("docwidth.lines") ?? "[]");
const phase = sessionStorage.getItem("docwidth.phase") ?? "A";

function check(id: string, label: string, ok: boolean, detail = ""): void {
  lines.push(`${ok ? "PASS" : "FAIL"}  [${id}] ${label}${ok ? "" : `  ${detail}`}`);
  sessionStorage.setItem("docwidth.lines", JSON.stringify(lines));
  out.textContent = lines.join("\n");
}
const rem = (n: number) => n * 16;
const near = (a: number, b: number) => Math.abs(a - b) <= 1;
const width = (el: Element | null) => el?.getBoundingClientRect().width ?? NaN;
const proseWidth = () => width(document.querySelector(".markdown-body"));
const radiosOf = () => [...document.querySelectorAll<HTMLButtonElement>('[role="radiogroup"][aria-label="문서 너비"] [role="radio"]')];
const checkedOf = () => radiosOf().find((r) => r.getAttribute("aria-checked") === "true")?.dataset.widthChoice ?? null;

async function openSettings(): Promise<void> {
  document.querySelector<HTMLElement>("#settings-button")!.click();
  for (let i = 0; i < 40 && radiosOf().length === 0; i++) await wait(50);
}
async function closeSettings(): Promise<void> {
  document.querySelector<HTMLElement>(".settings-close")?.click();
  await wait(60);
}
async function pick(value: string): Promise<void> {
  radiosOf().find((r) => r.dataset.widthChoice === value)!.click();
  await wait(60);
}

async function main(): Promise<void> {
  for (let i = 0; i < 100 && tabs().length < 1; i++) await wait(60);
  await wait(200);
  const preview = document.querySelector<HTMLElement>(".preview")!;
  const stored = () => localStorage.getItem("markview.docWidth");

  if (phase === "A") {
    check("W00", "저장값이 없으면 보기 모드 폭은 기존 46rem(736px)이고 --doc-width가 없다", near(proseWidth(), rem(46)) && !document.documentElement.style.getPropertyValue("--doc-width"), `w=${proseWidth()}`);

    await openSettings();
    const radios = radiosOf();
    check(
      "W01",
      "'모양' 탭에 문서 너비 4개 선택지(좁게·보통·넓게·전체)가 radiogroup으로 있고 '보통'이 선택돼 있다",
      JSON.stringify(radios.map((r) => r.textContent)) === JSON.stringify(["좁게", "보통", "넓게", "전체"]) && checkedOf() === "normal",
      `labels=${JSON.stringify(radios.map((r) => r.textContent))} checked=${checkedOf()}`,
    );

    const got: Record<string, number> = {};
    for (const v of ["narrow", "wide", "full", "normal"]) {
      await pick(v);
      got[v] = proseWidth();
    }
    check(
      "W02",
      "보기 모드 폭: 좁게 38rem·넓게 64rem·전체는 프리뷰 폭·보통은 46rem으로 새로고침 없이 바뀐다",
      near(got.narrow, rem(38)) && near(got.wide, rem(64)) && near(got.full, preview.clientWidth) && near(got.normal, rem(46)),
      JSON.stringify({ ...got, preview: preview.clientWidth }),
    );
    check("W03", "'보통'을 고르면 --doc-width 변수가 지워진다", !document.documentElement.style.getPropertyValue("--doc-width"), document.documentElement.style.getPropertyValue("--doc-width"));

    // 키보드: ← / → 로 바꾸고 포커스가 따라가며 양 끝에서 돈다
    const normal = radiosOf().find((r) => r.dataset.widthChoice === "normal")!;
    normal.focus();
    normal.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    await wait(60);
    const afterRight = checkedOf();
    const rightWidth = proseWidth();
    radiosOf().find((r) => r.dataset.widthChoice === "full")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    await wait(60);
    const wrapped = checkedOf();
    radiosOf().find((r) => r.dataset.widthChoice === "narrow")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
    await wait(60);
    const wrappedBack = checkedOf();
    check(
      "W04",
      "→는 다음 단계로(넓게)·전체에서 좁게로, ←는 좁게에서 전체로 돌고, 폭이 바로 바뀌고 포커스가 따라간다",
      afterRight === "wide" && near(rightWidth, rem(64)) && wrapped === "narrow" && wrappedBack === "full" && document.activeElement === radiosOf().find((r) => r.dataset.widthChoice === "full"),
      `right=${afterRight}/${rightWidth} wrapped=${wrapped} back=${wrappedBack} focus=${(document.activeElement as HTMLElement | null)?.dataset?.widthChoice}`,
    );

    // 편집 전용(Muya): 같은 단계를 따른다. 보통은 기존 800px.
    await pick("normal");
    await closeSettings();
    clickMode("edit");
    await muyaOf(tabs()[0]);
    await wait(300);
    const column = () => width(document.querySelector(".muya-host .mu-container"));
    const editor = document.querySelector<HTMLElement>(".muya-host .mu-editor")!;
    const edit: Record<string, number> = { normal: column() };
    for (const v of ["narrow", "wide", "full"]) {
      await openSettings();
      await pick(v);
      await closeSettings();
      await wait(100);
      edit[v] = column();
    }
    check(
      "W05",
      "편집 전용(Muya) 열 폭도 같은 단계를 따른다: 보통 800px(기존)·좁게 38rem·넓게 64rem·전체는 편집 영역 폭",
      near(edit.normal, 800) && near(edit.narrow, rem(38)) && near(edit.wide, rem(64)) && near(edit.full, editor.clientWidth),
      JSON.stringify({ ...edit, editor: editor.clientWidth }),
    );

    // 저장·유지: '넓게'를 골라 저장하고 새로고침한다(다음 phase에서 시작 폭을 본다)
    await openSettings();
    await pick("wide");
    check("W06", "고른 단계가 localStorage(markview.docWidth)에 저장된다", stored() === "wide", `stored=${stored()}`);
    await closeSettings();
    clickMode("view");
    await wait(100);
    sessionStorage.setItem("docwidth.phase", "B");
    location.reload();
    return;
  }

  if (phase === "B") {
    const startWidth = proseWidth();
    await openSettings();
    check("W07", "새로고침 뒤에도 저장된 '넓게'가 시작할 때 이미 적용되고(64rem) 설정에도 선택돼 보인다", near(startWidth, rem(64)) && checkedOf() === "wide", `start=${startWidth} checked=${checkedOf()}`);
    await closeSettings();
    localStorage.setItem("markview.docWidth", "bogus");
    sessionStorage.setItem("docwidth.phase", "C");
    location.reload();
    return;
  }

  // phase C — 잘못 저장된 값은 '보통'
  const badWidth = proseWidth();
  await openSettings();
  check("W08", "잘못 저장된 값은 '보통'으로 다룬다(46rem, 보통 선택 표시)", near(badWidth, rem(46)) && checkedOf() === "normal", `w=${badWidth} checked=${checkedOf()}`);
  lines.push("DONE");
  out.textContent = lines.join("\n");
  sessionStorage.removeItem("docwidth.lines");
  sessionStorage.removeItem("docwidth.phase");
}

void main().catch((error) => {
  check("", "하네스 예외", false, String(error));
  lines.push("DONE");
  out.textContent = lines.join("\n");
});

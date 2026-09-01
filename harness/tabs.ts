// 탭 전환 시 감춰진 페인이 실제로 사라지는지 — hidden 속성의 computed display를 양쪽 상태에서 잰다.
// `node harness/build-mocked.mjs tabs` 로 만들고 `?files=2` 를 붙여 연다.
const out = document.querySelector<HTMLElement>("#out")!;
const lines: string[] = [];
let fail = 0;

function eq(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  lines.push(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
}

const wait = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

function panes() {
  return [...document.querySelectorAll<HTMLElement>(".pane")].map((el) => ({
    hidden: el.hidden,
    display: getComputedStyle(el).display,
  }));
}

const want = Number(new URLSearchParams(location.search).get("files") ?? 2);

async function run(): Promise<void> {
  for (let i = 0; i < 60 && document.querySelectorAll(".pane").length < want; i++) await wait(60);
  const tabs = [...document.querySelectorAll<HTMLElement>(".tab")];
  eq(`탭 ${want}개가 열렸다`, tabs.length, want);
  if (tabs.length < 2) { out.textContent = lines.join("\n") + "\n\n모킹 실패"; return; }

  lines.push(`페인 상태: ${JSON.stringify(panes())}`);
  eq("보이는 페인은 정확히 1개", panes().filter((p) => p.display !== "none").length, 1);
  const hiddenDisplays = [...new Set(panes().filter((p) => p.hidden).map((p) => p.display))];
  eq("감춰진 페인의 computed display", hiddenDisplays, ["none"]);

  // 첫 탭으로 전환해도 같은지 (양쪽 상태 모두 측정 — 회고 260823-002646a)
  tabs[0].click();
  await wait(60);
  lines.push(`전환 후: ${JSON.stringify(panes())}`);
  eq("전환 후에도 보이는 페인 1개", panes().filter((p) => p.display !== "none").length, 1);

  lines.push("", fail === 0 ? "전부 통과" : `실패 ${fail}건`);
  out.textContent = lines.join("\n");
}

void run();

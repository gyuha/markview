// 탭 격리(S05) — 탭 두 개에서 각각 Muya로 입력해도 섞이지 않고, 탭을 오가도 각자 유지된다.
import { activeTab, check, clickMode, guard, muyaOf, openTab, ready, tabs, typeAtEnd, visible, wait } from "./lib-muya";

await guard(async () => {
  if (!(await ready())) return check("", "탭이 열렸다", false);
  const a = activeTab()!;
  const b = (await openTab("/tmp/harness-b.md"))!;

  a.button.click();
  clickMode("edit");
  const muyaA = await muyaOf(a);
  await typeAtEnd(muyaA!.domNode.querySelector(".mu-paragraph .mu-content")!, "에이탭");

  b.button.click();
  clickMode("edit");
  const muyaB = await muyaOf(b);
  await typeAtEnd(muyaB!.domNode.querySelector(".mu-paragraph .mu-content")!, "비탭");

  a.button.click();
  await wait(100);
  const mdA = muyaA!.getMarkdown();
  const mdB = muyaB!.getMarkdown();
  const isolated =
    tabs().length === 2 &&
    muyaA !== muyaB &&
    mdA.includes("에이탭") &&
    !mdA.includes("비탭") &&
    mdB.includes("비탭") &&
    !mdB.includes("에이탭") &&
    a.source.includes("에이탭") &&
    !a.source.includes("비탭") &&
    b.source.includes("비탭") &&
    !b.source.includes("에이탭") &&
    visible(muyaA!.domNode) &&
    !visible(muyaB!.domNode);
  check("S05", "탭 2개의 Muya 입력이 섞이지 않고 탭을 오가도 유지", isolated, JSON.stringify({ mdA, mdB }));
});

// 편집 모드의 이미지 붙여넣기·드롭(P01–P04). 붙여넣기는 ClipboardEvent에 image/png File을 담아, 드롭은
// Tauri 창 이벤트(tauri://drag-drop)로 흉내 낸다. Rust 커맨드(save_asset·copy_asset)는 모킹이 대신하고 —
// 해시 이름 규칙과 경로 검증은 `cargo test`(src-tauri/src/assets.rs)가 지킨다 — 여기서는 앱이 올바른 인자로
// 부르고, 돌려받은 상대 경로를 문서에 넣고, 그 이미지가 convertFileSrc 값으로 실제로 보이는지를 본다.
import {
  activeTab,
  calls,
  check,
  clickMode,
  emitTauri,
  guard,
  injectViaSplit,
  muyaOf,
  ready,
  respond,
  tabs,
  wait,
  waitFor,
} from "./lib-muya";

// 1×1 PNG
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const bytes = Uint8Array.from(atob(PNG_B64), (c) => c.charCodeAt(0));

async function sha1Hex(data: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const sameBytes = (base64: unknown) =>
  typeof base64 === "string" && atob(base64) === atob(PNG_B64);

interface Internals {
  convertFileSrc: (path: string, protocol?: string) => string;
}

await guard(async () => {
  if (!(await ready())) return check("", "탭이 열렸다", false);
  const tab = activeTab()!;
  const docPath = tab.path; // /tmp/harness.md
  const hash = await sha1Hex(bytes);
  const pastedRel = `assets/${hash}.png`;
  const droppedRel = "assets/dropped.png";
  respond("save_asset", () => pastedRel);
  respond("copy_asset", () => droppedRel);

  // 문서 폴더 기준 절대 경로를 convertFileSrc에 넣은 값 — 그 값이 실제 이미지가 되도록 바꿔 둔다.
  const internals = (window as unknown as { __TAURI_INTERNALS__: Internals }).__TAURI_INTERNALS__;
  const original = internals.convertFileSrc;
  const blobUrl = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
  const assetUrls: Record<string, string> = {};
  internals.convertFileSrc = (path, protocol) =>
    path.endsWith(pastedRel) || path.endsWith(droppedRel) ? (assetUrls[path] ??= `${blobUrl}#${path}`) : original(path, protocol);
  const want = (rel: string) => internals.convertFileSrc(`/tmp/${rel}`);

  injectViaSplit("첫째 문단\n\n둘째 문단\n");
  clickMode("edit");
  const muya = await muyaOf(tab);
  if (!muya) return check("", "Muya가 만들어졌다", false);
  await wait(250);
  const root = muya.domNode;
  const paragraphs = () => [...root.querySelectorAll(".mu-paragraph")];
  const md = () => muya.getMarkdown();

  // ── P01 붙여넣기 ─────────────────────────────────────────────────────
  const first = root.querySelector(".mu-paragraph .mu-content")!;
  const range = document.createRange();
  range.selectNodeContents(first);
  range.collapse(false);
  getSelection()!.removeAllRanges();
  getSelection()!.addRange(range);
  const transfer = new DataTransfer();
  transfer.items.add(new File([bytes], "screenshot.png", { type: "image/png" }));
  first.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
  await waitFor(() => md().includes(pastedRel), 3000);
  const save = calls().find((c) => c.cmd === "save_asset");
  const p01 =
    !!save &&
    save.args?.docPath === docPath &&
    save.args?.ext === "png" &&
    sameBytes(save.args?.data) &&
    md().includes(`](${pastedRel})`) &&
    !md().includes("data:image");
  check("P01", "이미지 붙여넣기 → 문서의 assets/에 그 바이트를 쓰는 IPC → ![…](assets/<해시>.png) 삽입", p01, JSON.stringify({ args: save && { ...save.args, data: `${String(save.args?.data).slice(0, 12)}…` }, md: md() }));

  // ── P04 삽입된 이미지가 convertFileSrc 값으로 보인다 ────────────────────
  const shownImg = (url: string) =>
    [...root.querySelectorAll<HTMLImageElement>("img")].find((i) => i.getAttribute("src") === url && i.naturalWidth > 0);
  const pastedShown = !!(await waitFor(() => shownImg(want(pastedRel)), 3000));

  // ── P02 이미지 드롭 → 놓은 문단에 복사본 삽입 ─────────────────────────────
  const second = paragraphs()[1].querySelector(".mu-content")!;
  const r = second.getBoundingClientRect();
  const dropped = "/Users/someone/Desktop/photo.png";
  // macOS(wry)의 드롭 좌표는 창 기준 포인트(= CSS 픽셀)다 — 배율을 곱하지 않는다.
  emitTauri("tauri://drag-drop", { paths: [dropped], position: { x: r.right - 2, y: r.top + r.height / 2 } });
  await waitFor(() => md().includes(droppedRel), 3000);
  const copy = calls().find((c) => c.cmd === "copy_asset");
  const inSecond = md().split("\n\n").find((block) => block.includes(droppedRel))?.startsWith("둘째 문단") ?? false;
  check(
    "P02",
    "편집기 위에 이미지 파일 드롭 → assets/로 복사하는 IPC → 놓은 문단에 상대 경로로 삽입",
    !!copy && copy.args?.docPath === docPath && copy.args?.src === dropped && md().includes(`](${droppedRel})`) && inSecond,
    JSON.stringify({ args: copy?.args, md: md() }),
  );
  const droppedShown = !!(await waitFor(() => shownImg(want(droppedRel)), 3000));
  check("P04", "붙여넣기·드롭으로 넣은 이미지가 Muya 안에서 convertFileSrc 값으로 보인다", pastedShown && droppedShown, JSON.stringify({ pastedShown, droppedShown, imgs: [...root.querySelectorAll("img")].map((i) => i.getAttribute("src")) }));

  // ── P03 .md 드롭은 편집 모드에서도 탭으로 열린다 ───────────────────────────
  const before = md();
  const tabsBefore = tabs().length;
  emitTauri("tauri://drag-drop", { paths: ["/tmp/dropped-note.md"], position: { x: r.left + 5, y: r.top + 5 } });
  const opened = await waitFor(() => tabs().find((t) => t.path === "/tmp/dropped-note.md"), 3000);
  check(
    "P03",
    ".md 드롭은 편집 모드에서도 새 탭으로 열리고 이미지로 삽입되지 않는다",
    !!opened && tabs().length === tabsBefore + 1 && before === md() && !calls().some((c) => c.cmd === "copy_asset" && c.args?.src === "/tmp/dropped-note.md"),
    JSON.stringify({ opened: !!opened, tabs: tabs().length, changed: before !== md() }),
  );
  internals.convertFileSrc = original;
});

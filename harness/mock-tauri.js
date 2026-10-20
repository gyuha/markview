(() => {
  // ?mermaid=1 이면 mermaid 블록이 든 문서를 연다. 기본은 기존 하네스가 기대하는 문서 그대로다.
  const withMermaid = new URLSearchParams(location.search).get("mermaid") === "1";
  const DOC = {
    path: "/tmp/harness.md",
    text: withMermaid ? "제목\n\n```mermaid\ngraph TD; A-->B;\n```\n" : "제목\n\n본문 한 줄\n",
    mtime_ms: 1,
  };
  // ?files=N 으로 탭 여러 개를 열 수 있다. 기본 1이라 기존 하네스는 영향받지 않는다.
  const fileCount = Number(new URLSearchParams(location.search).get("files") ?? 1);
  // ?files=0 이면 시작 시 아무 파일도 열리지 않는다(기록 없는 첫 실행 재현).
  const paths =
    fileCount === 0
      ? []
      : [
          DOC.path,
          ...Array.from({ length: Math.max(0, fileCount - 1) }, (_, i) => `/tmp/harness-${i + 2}.md`),
        ];

  // 하네스가 관측할 호출 기록. 각 호출에 그 시점의 data-theme을 함께 남긴다 —
  // 네이티브 테마 적용이 CSS 적용보다 먼저인지를 동기적으로 판정할 수 있다.
  // (MutationObserver는 마이크로태스크라 순서가 뒤바뀐 코드도 통과시킨다.)
  window.__TAURI_MOCK_CALLS__ = [];
  window.__LISTENERS__ = {};
  window.__emitTauri = (event, payload) => (window.__LISTENERS__[event] ?? []).forEach((cb) => cb({ event, id: 0, payload }));

  // 이전 하네스가 남긴 선택 테마 때문에 결과가 흔들리지 않도록 기준 상태로 되돌린다.
  try {
    localStorage.removeItem("markview.theme");
    localStorage.removeItem("markview.theme.light");
    localStorage.removeItem("markview.theme.dark");
  } catch {}

  // 세션 복원 하네스용 시드. 이전 페이지가 남긴 세션이 이 페이지의 복원에 새지 않도록 매번 지우고,
  // 쿼리로 지정한 것만 심는다. ?seedSession=a,b · ?seedActive=b · ?seedLegacy=1 · ?seedOther=x · ?windowInit=x · ?restore=off · ?seedRecent=x,y · ?missing=b
  const q = new URLSearchParams(location.search);
  const list = (name) => (q.get(name) ?? "").split(",").filter(Boolean);
  const missing = new Set(list("missing"));
  let windowInit = q.get("windowInit");
  try {
    localStorage.removeItem("markview.session");
    localStorage.removeItem("markview.restoreSession");
    if (q.has("seedSession")) {
      const entry = { paths: list("seedSession"), active: q.get("seedActive") };
      // ?seedLegacy=1 은 창 라벨 도입 전의 단일 값 형식을 심는다.
      localStorage.setItem("markview.session", JSON.stringify(q.has("seedLegacy") ? entry : { windows: { main: entry } }));
    }
    // ?seedOther=x 는 다른 창(w2)의 세션 항목을 심는다. 이 창(main)이 건드리면 안 된다.
    if (q.has("seedOther")) {
      const cur = JSON.parse(localStorage.getItem("markview.session") ?? '{"windows":{}}');
      cur.windows.w2 = { paths: list("seedOther"), active: list("seedOther")[0] ?? null };
      localStorage.setItem("markview.session", JSON.stringify(cur));
    }
    if (q.get("restore") === "off") localStorage.setItem("markview.restoreSession", "false");
    if (q.has("seedRecent")) localStorage.setItem("markview.recent", JSON.stringify(list("seedRecent")));
  } catch {}
  // 세션 쓰기 관측 — 복원 도중에 부분 상태가 기록되지 않는지(S06) 판정한다.
  window.__SESSION_WRITES__ = [];
  const nativeSetItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key, value) {
    if (key === "markview.session") window.__SESSION_WRITES__.push(value);
    return nativeSetItem.call(this, key, value);
  };

  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    transformCallback: (cb) => { const id = Math.floor(Math.random() * 1e9); window[`_cb_${id}`] = cb; return id; },
    convertFileSrc: (p) => p,
    invoke: async (cmd, args) => {
      window.__TAURI_MOCK_CALLS__.push({
        cmd,
        args,
        domTheme: document.documentElement.dataset.theme ?? null,
      });
      if (cmd === "read_markdown") {
        if (missing.has(args?.path)) throw `파일을 찾을 수 없습니다: ${args.path}`;
        return { ...DOC, path: args?.path ?? DOC.path };
      }
      if (cmd === "take_pending_files") return paths;
      // 다중 창 소유 모킹. window.__OTHER_OWNED__(경로 배열)에 든 경로는 다른 창(w2)이 쥔 것으로 답한다.
      if (cmd === "claim_file") return (window.__OTHER_OWNED__ ?? []).includes(args?.path) ? { "other-window": "w2" } : "granted";
      if (cmd === "release_file") return null;
      // 저장 모킹. 충돌 없이 성공한다.
      if (cmd === "write_markdown") return { conflict: false, mtime_ms: 1 };
      // 분리 모킹. window.__DETACH_FAIL__ 이면 거절하고, 아니면 Rust처럼 "merged"/"detached"를 돌려준다
      // (window.__DETACH_RESULT__ 로 고르고 기본은 "detached").
      if (cmd === "detach_tab") {
        if (window.__DETACH_FAIL__) throw "창을 만들 수 없습니다";
        return window.__DETACH_RESULT__ ?? "detached";
      }
      // ?windowInit=/x.md 는 분리로 만든 새 창의 시작 경로다(1회 소비). 없으면 메인 창처럼 null.
      if (cmd === "take_window_init") {
        const init = windowInit;
        windowInit = null;
        return init;
      }
      // ⌘O의 네이티브 파일 선택창. 하네스가 고른 경로(또는 null=취소)를 window.__PICK_MARKDOWN__에 둔다.
      if (cmd === "pick_markdown") return window.__PICK_MARKDOWN__ ?? null;
      // 이벤트 구독을 붙잡아 둔다 — 하네스가 window.__emitTauri(이벤트, 값)로 Rust 방송을 흉내 낸다.
      if (cmd === "plugin:event|listen") {
        (window.__LISTENERS__[args.event] ??= []).push(window[`_cb_${args.handler}`]);
        return 1;
      }
      return null;
    },
  };
})();

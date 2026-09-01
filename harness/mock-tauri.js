(() => {
  const DOC = { path: "/tmp/harness.md", text: "제목\n\n본문 한 줄\n", mtime_ms: 1 };
  // ?files=N 으로 탭 여러 개를 열 수 있다. 기본 1이라 기존 하네스는 영향받지 않는다.
  const fileCount = Number(new URLSearchParams(location.search).get("files") ?? 1);
  const paths = [
    DOC.path,
    ...Array.from({ length: Math.max(0, fileCount - 1) }, (_, i) => `/tmp/harness-${i + 2}.md`),
  ];

  // 하네스가 관측할 호출 기록. 각 호출에 그 시점의 data-theme을 함께 남긴다 —
  // 네이티브 테마 적용이 CSS 적용보다 먼저인지를 동기적으로 판정할 수 있다.
  // (MutationObserver는 마이크로태스크라 순서가 뒤바뀐 코드도 통과시킨다.)
  window.__TAURI_MOCK_CALLS__ = [];

  // 이전 하네스가 남긴 선택 테마 때문에 결과가 흔들리지 않도록 기준 상태로 되돌린다.
  try {
    localStorage.removeItem("markview.theme");
  } catch {}

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
      if (cmd === "read_markdown") return { ...DOC, path: args?.path ?? DOC.path };
      if (cmd === "take_pending_files") return paths;
      if (cmd === "plugin:event|listen") return 1;
      return null;
    },
  };
})();

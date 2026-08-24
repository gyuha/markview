(() => {
  const DOC = { path: "/tmp/harness.md", text: "제목\n\n본문 한 줄\n", mtime_ms: 1 };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    transformCallback: (cb) => { const id = Math.floor(Math.random() * 1e9); window[`_cb_${id}`] = cb; return id; },
    convertFileSrc: (p) => p,
    invoke: async (cmd) => {
      if (cmd === "read_markdown") return DOC;
      if (cmd === "take_pending_files") return [DOC.path];
      if (cmd === "plugin:event|listen") return 1;
      return null;
    },
  };
})();

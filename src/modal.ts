/**
 * 확인 대화상자. `plugin-dialog`를 쓰지 않고 자체 HTML로 만든다 —
 * 의존성을 늘리지 않고, 테마 변수를 그대로 따르게 하려는 것이다.
 */
export interface ConfirmOptions {
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
}

export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";

    const box = document.createElement("div");
    box.className = "modal";
    box.setAttribute("role", "alertdialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-label", options.message);

    const text = document.createElement("p");
    text.className = "modal-message";
    text.textContent = options.message;

    const row = document.createElement("div");
    row.className = "modal-actions";

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "modal-cancel";
    cancel.textContent = options.cancelLabel ?? "취소";

    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "modal-confirm";
    confirm.textContent = options.confirmLabel;

    row.append(cancel, confirm);
    box.append(text, row);
    backdrop.appendChild(box);
    document.body.appendChild(backdrop);

    const close = (result: boolean) => {
      document.removeEventListener("keydown", onKey, true);
      backdrop.remove();
      resolve(result);
    };
    // Esc는 취소, Enter는 승인. 캡처 단계에서 잡아 에디터 키맵보다 먼저 처리한다.
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close(false);
      } else if (event.key === "Enter") {
        event.preventDefault();
        close(true);
      }
    };

    cancel.addEventListener("click", () => close(false));
    confirm.addEventListener("click", () => close(true));
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) close(false);
    });
    document.addEventListener("keydown", onKey, true);
    confirm.focus();
  });
}

export interface TableSize {
  rows: number;
  columns: number;
}

/**
 * 표 삽입 대화상자 — MarkText의 "표 삽입"(행·열, 1~30)과 같은 내용을 확인 대화상자와 같은 모양으로.
 * 확인하면 고른 크기, 취소하면 null.
 */
export function tableDialog(initial: TableSize): Promise<TableSize | null> {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";

    const box = document.createElement("div");
    box.className = "modal";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-label", "표 삽입");

    const title = document.createElement("p");
    title.className = "modal-message";
    title.textContent = "표 삽입";

    const field = (label: string, value: number) => {
      const wrap = document.createElement("label");
      wrap.className = "modal-field";
      const input = document.createElement("input");
      input.type = "number";
      input.min = "1";
      input.max = "30";
      input.value = String(value);
      wrap.append(label, input);
      return { wrap, input };
    };
    const rows = field("행", initial.rows);
    const columns = field("열", initial.columns);

    const row = document.createElement("div");
    row.className = "modal-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "modal-cancel";
    cancel.textContent = "취소";
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "modal-confirm";
    confirm.textContent = "확인";
    row.append(cancel, confirm);

    box.append(title, rows.wrap, columns.wrap, row);
    backdrop.appendChild(box);
    document.body.appendChild(backdrop);

    const clamp = (input: HTMLInputElement) => Math.min(30, Math.max(1, Math.round(Number(input.value) || 1)));
    const close = (result: TableSize | null) => {
      document.removeEventListener("keydown", onKey, true);
      backdrop.remove();
      resolve(result);
    };
    const accept = () => close({ rows: clamp(rows.input), columns: clamp(columns.input) });
    // Esc는 취소, Enter는 승인. 캡처 단계에서 잡아 에디터 키맵보다 먼저 처리한다(confirmDialog와 같다).
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close(null);
      } else if (event.key === "Enter") {
        event.preventDefault();
        accept();
      }
    };

    cancel.addEventListener("click", () => close(null));
    confirm.addEventListener("click", accept);
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) close(null);
    });
    document.addEventListener("keydown", onKey, true);
    rows.input.focus();
    rows.input.select();
  });
}

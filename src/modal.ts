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

import { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";

// 브라우저 기본 confirm/alert 대신 앱 테마에 맞는 모달. await confirmDialog("...")처럼 window.confirm 자리에 바로 쓴다.
interface DialogOptions {
  title?: string;
  confirmText?: string;
  cancelText?: string;
  alertOnly?: boolean; // true면 확인 버튼만(alert 대용)
}

function Dialog({ message, options, onClose }: { message: string; options: DialogOptions; onClose: (ok: boolean) => void }) {
  const okRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    okRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={() => onClose(false)}>
      <div className="modal confirm-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        {options.title && <h3>{options.title}</h3>}
        <p className="confirm-message">{message}</p>
        <div className="confirm-actions">
          {!options.alertOnly && (
            <button className="ghost" onClick={() => onClose(false)}>
              {options.cancelText ?? "취소"}
            </button>
          )}
          <button ref={okRef} onClick={() => onClose(true)}>
            {options.confirmText ?? "확인"}
          </button>
        </div>
      </div>
    </div>
  );
}

function openDialog(message: string, options: DialogOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const close = (ok: boolean) => {
      root.unmount();
      host.remove();
      resolve(ok);
    };
    root.render(<Dialog message={message} options={options} onClose={close} />);
  });
}

export function confirmDialog(message: string, options: Omit<DialogOptions, "alertOnly"> = {}): Promise<boolean> {
  return openDialog(message, options);
}

export function alertDialog(message: string, options: Omit<DialogOptions, "alertOnly" | "cancelText"> = {}): Promise<void> {
  return openDialog(message, { ...options, alertOnly: true }).then(() => undefined);
}

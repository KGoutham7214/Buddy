import { useCallback, useEffect, useId, useRef, useState } from "react";

type ConfirmRequest = {
  title: string;
  message: string;
  confirmLabel?: string;
  resolve: (ok: boolean) => void;
};

export function useConfirm() {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);

  const confirm = useCallback(
    (options: {
      title: string;
      message: string;
      confirmLabel?: string;
    }) =>
      new Promise<boolean>((resolve) => {
        setRequest({ ...options, resolve });
      }),
    []
  );

  const dialog = request ? (
    <ConfirmDialog
      title={request.title}
      message={request.message}
      confirmLabel={request.confirmLabel || "Delete"}
      onConfirm={() => {
        request.resolve(true);
        setRequest(null);
      }}
      onCancel={() => {
        request.resolve(false);
        setRequest(null);
      }}
    />
  ) : null;

  return { confirm, dialog };
}

type DialogProps = {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
};

function ConfirmDialog({
  title,
  message,
  confirmLabel,
  onConfirm,
  onCancel,
}: DialogProps) {
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      className="confirm-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <h3 id={titleId} className="confirm-title">
          {title}
        </h3>
        <p className="confirm-message">{message}</p>
        <div className="confirm-actions">
          <button
            ref={cancelRef}
            type="button"
            className="btn btn-ghost"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useRef } from "react";

export type StatusKind = "processing" | "success" | "error" | "confirm";

export interface StatusPopupState {
  kind: StatusKind;
  title: string;
  message: string;
  yesLabel?: string;
  noLabel?: string;
  /** Shown on processing when onCancel is provided */
  cancelLabel?: string;
}

export function StatusPopup({
  status,
  onClose,
  onYes,
  onNo,
  onCancel,
}: {
  status: StatusPopupState | null;
  onClose: () => void;
  onYes?: () => void;
  onNo?: () => void;
  onCancel?: () => void;
}) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onYesRef = useRef(onYes);
  onYesRef.current = onYes;
  const onNoRef = useRef(onNo);
  onNoRef.current = onNo;
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  useEffect(() => {
    if (!status || status.kind !== "success") return;
    const t = window.setTimeout(() => onCloseRef.current(), 4500);
    return () => window.clearTimeout(t);
  }, [status]);

  useEffect(() => {
    if (!status) return;
    const kind = status.kind;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (kind === "processing") {
        if (onCancelRef.current) onCancelRef.current();
        return;
      }
      if (kind === "confirm") onNoRef.current?.();
      else onCloseRef.current();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [status]);

  if (!status) return null;

  const isConfirm = status.kind === "confirm";
  const canDismiss = status.kind !== "processing" && !isConfirm;
  const canCancel = status.kind === "processing" && Boolean(onCancel);

  return (
    <div
      className="status-popup-backdrop"
      role="presentation"
      onClick={() => {
        if (canDismiss) onCloseRef.current();
      }}
    >
      <div
        className={`status-popup status-popup-${status.kind}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="status-popup-title"
        aria-describedby="status-popup-msg"
        aria-busy={status.kind === "processing"}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="status-popup-icon" aria-hidden>
          {status.kind === "processing" ? (
            <span className="status-spinner" />
          ) : status.kind === "success" ? (
            <span className="status-mark">✓</span>
          ) : status.kind === "confirm" ? (
            <span className="status-mark">?</span>
          ) : (
            <span className="status-mark">!</span>
          )}
        </div>
        <h2 id="status-popup-title">{status.title}</h2>
        <p id="status-popup-msg">{status.message}</p>
        {status.kind === "processing" ? (
          <>
            <p className="status-popup-wait">Isso pode levar alguns minutos…</p>
            {canCancel && (
              <div className="status-popup-actions">
                <button
                  type="button"
                  className="ghost"
                  onClick={() => onCancelRef.current?.()}
                >
                  {status.cancelLabel ?? "Cancelar"}
                </button>
              </div>
            )}
          </>
        ) : isConfirm ? (
          <div className="status-popup-actions">
            <button
              type="button"
              className="ghost"
              onClick={() => onNoRef.current?.()}
            >
              {status.noLabel ?? "Não"}
            </button>
            <button
              type="button"
              className="cta small"
              onClick={() => onYesRef.current?.()}
            >
              {status.yesLabel ?? "Sim"}
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="cta small"
            onClick={() => onCloseRef.current()}
          >
            Ok
          </button>
        )}
      </div>
    </div>
  );
}

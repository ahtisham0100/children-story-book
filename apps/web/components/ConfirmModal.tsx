"use client";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useDialog } from "./useDialog";

export interface ConfirmModalProps {
  open: boolean;
  title: string;
  /** Explanation shown above the buttons. */
  children?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** Styles the confirm button as destructive. */
  danger?: boolean;
  /** When set, the user must type exactly this (e.g. "DELETE") to enable confirm. */
  requireText?: string;
  /** Disables both buttons and shows the confirm as in progress. */
  busy?: boolean;
  /** Shown in an alert region (e.g. the API's error message). */
  error?: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * The one confirmation dialog for every destructive or state-changing action
 * (My Data deletion, admin retries, status changes, deletions). Accessible:
 * role="dialog" + aria-modal, labelled by its heading, described by its body,
 * focus trapped inside, Escape cancels, focus returns to the trigger (see
 * useDialog). Rendered in a portal so it stacks above drawers and modals.
 */
export function ConfirmModal({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel = "Cancel",
  danger = false,
  requireText,
  busy = false,
  error,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  const titleId = useId();
  const bodyId = useId();
  const inputId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [typed, setTyped] = useState("");

  // A fresh modal never starts pre-confirmed.
  useEffect(() => {
    if (open) setTyped("");
  }, [open]);

  useDialog(dialogRef, open, () => {
    if (!busy) onCancel();
  });

  if (!open || typeof document === "undefined") return null;

  const canConfirm = !busy && (requireText === undefined || typed === requireText);

  return createPortal(
    <div
      className="modal__backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        className="modal card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={children ? bodyId : undefined}
        tabIndex={-1}
      >
        <h2 id={titleId} className="modal__title">
          {title}
        </h2>
        {children && (
          <div id={bodyId} className="modal__body">
            {children}
          </div>
        )}

        {requireText !== undefined && (
          <div className="field modal__confirm-field">
            <label htmlFor={inputId}>
              Type <strong>{requireText}</strong> to confirm
            </label>
            <input
              id={inputId}
              type="text"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              value={typed}
              disabled={busy}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canConfirm) onConfirm();
              }}
            />
          </div>
        )}

        {error && (
          <div className="notice notice--error modal__error" role="alert">
            {error}
          </div>
        )}

        <div className="modal__actions">
          <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`btn ${danger ? "btn-danger" : "btn-primary"}`}
            onClick={onConfirm}
            disabled={!canConfirm}
            aria-busy={busy || undefined}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

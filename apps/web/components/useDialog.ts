"use client";
import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

// Open dialogs, innermost last. Only the top one handles keys, so Escape in a
// ConfirmModal opened from the admin job drawer closes the modal, not both.
const dialogStack: object[] = [];

/**
 * Modal-dialog behaviour shared by every dialog (ConfirmModal, BookPreviewModal,
 * the admin job drawer):
 *  - on open, remembers what had focus and moves focus into the dialog
 *    (`initialFocus` if given, else the first focusable element, else the
 *    dialog itself — give it tabIndex={-1});
 *  - Tab / Shift+Tab wrap inside the dialog, so focus can't reach the page
 *    behind it;
 *  - Escape calls `onEscape` (normally the close handler);
 *  - on close/unmount, focus returns to the element that opened it;
 *  - body scroll is locked while open;
 *  - dialogs nest: only the innermost open one reacts to keys.
 *
 * `onEscape` is read through a ref, so callers can pass an inline arrow
 * without re-running the effect (which would steal focus back on every render).
 */
export function useDialog(
  dialogRef: RefObject<HTMLElement>,
  open: boolean,
  onEscape: () => void,
  initialFocus?: RefObject<HTMLElement>,
) {
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const token = {};
    dialogStack.push(token);
    const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const first = initialFocus?.current ?? focusableIn(dialog)[0] ?? dialog;
    first.focus();

    // Scroll lock stays until the OUTERMOST dialog closes (each restores what it saw).
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function onKeyDown(event: KeyboardEvent) {
      if (dialogStack[dialogStack.length - 1] !== token) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onEscapeRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const items = focusableIn(dialog);
      if (items.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const firstItem = items[0]!;
      const lastItem = items[items.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey && (active === firstItem || !dialog.contains(active))) {
        event.preventDefault();
        lastItem.focus();
      } else if (!event.shiftKey && (active === lastItem || !dialog.contains(active))) {
        event.preventDefault();
        firstItem.focus();
      }
    }
    // Capture phase on the document: the dialog sees Escape/Tab before any
    // page-level handler, and still gets them if focus somehow escaped.
    document.addEventListener("keydown", onKeyDown, true);

    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      dialogStack.splice(dialogStack.indexOf(token), 1);
      document.body.style.overflow = previousOverflow;
      if (returnTo && document.contains(returnTo)) returnTo.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}

import { useEffect, type RefObject } from "react";

/**
 * Make a modal/dialog accessible with minimal structural change.
 *
 * Wires the four behaviors every modal in the app was missing:
 *   1. **Escape to close** — calls `onClose` on Escape (capture phase, so it
 *      fires before app-level shortcuts).
 *   2. **Focus trap** — Tab / Shift+Tab cycle within the panel instead of
 *      escaping to the page behind it.
 *   3. **Initial focus** — focuses the first focusable element (or the panel)
 *      on open, so keyboard/screen-reader users land inside the dialog.
 *   4. **Focus restoration** — returns focus to the element that was focused
 *      before the dialog opened, on unmount.
 *
 * The caller still sets `role="dialog"`, `aria-modal="true"`, and an
 * accessible name (`aria-label` / `aria-labelledby`) on the panel element,
 * and attaches `panelRef` to it.
 *
 * @param panelRef - ref to the dialog panel element (the focus-trap boundary).
 * @param onClose  - close handler; omit for modals with no dismiss affordance.
 */
export function useModalA11y(
  panelRef: RefObject<HTMLElement | null>,
  onClose?: () => void,
): void {
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;

    const FOCUSABLE =
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

    // Initial focus: first focusable child, else the panel itself.
    const initial = panel?.querySelector<HTMLElement>(FOCUSABLE);
    (initial ?? panel)?.focus?.();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && onClose) {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      // Restore focus to the opener (guard: it may have been removed).
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus?.();
      }
    };
  }, [panelRef, onClose]);
}

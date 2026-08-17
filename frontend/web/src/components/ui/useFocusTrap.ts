"use client";

import { useEffect, type RefObject } from "react";

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Focus trap + focus restore for a portal-rendered dialog/drawer. Extracted
 * from Modal.tsx (C76) so RunNotifier and MobileNav — both hand-rolled
 * role="dialog" aria-modal="true" overlays that never picked up Modal's
 * trap — get the same behavior instead of a third divergent copy.
 *
 * On open: remembers the currently-focused element, moves focus into the
 * container next frame (after the portal mounts), and wraps Tab/Shift+Tab
 * at the container's first/last focusable descendant so focus can't escape
 * to the page behind the overlay.
 * On close: restores focus to whatever had it before the dialog opened.
 *
 * Escape-to-close is intentionally NOT handled here — callers that already
 * have their own Escape listener (RunNotifier, MobileNav) keep it; Modal
 * still owns its own via `onClose`.
 */
export function useFocusTrap(open: boolean, containerRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;

    const previousFocus = document.activeElement as HTMLElement | null;

    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Tab" || !containerRef.current) return;
      const focusable = containerRef.current.querySelectorAll(FOCUSABLE);
      if (focusable.length === 0) return;
      const first = focusable[0] as HTMLElement;
      const last = focusable[focusable.length - 1] as HTMLElement;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    const id = requestAnimationFrame(() => containerRef.current?.focus());

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      cancelAnimationFrame(id);
      previousFocus?.focus();
    };
  }, [open, containerRef]);
}

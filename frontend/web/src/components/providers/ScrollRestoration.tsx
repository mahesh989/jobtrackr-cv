"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

/**
 * Remembers and restores the dashboard's scroll position.
 *
 * The app doesn't scroll the window — the main column is its own
 * `overflow-y-auto` container (see the dashboard layout). Browser scroll
 * restoration and Next's own only ever act on the window, so every navigation
 * left that container at 0. Going to the full analysis page and pressing Back
 * therefore returned to the *top* of the dashboard rather than the job the user
 * had been reading, and the same applied to any in-app round trip.
 *
 * Position is keyed by pathname (not the full URL) so filter and `?job=` changes
 * within the board share one entry — those are in-place updates where the user
 * expects to stay put. sessionStorage keeps it per-tab and drops it on close.
 */
const KEY_PREFIX = "jt_scroll:";

/** The dashboard layout's scrolling main column. */
function getScroller(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-scroll-container]");
}

export function ScrollRestoration() {
  const pathname = usePathname();

  useEffect(() => {
    const el = getScroller();
    if (!el) return;
    const key = KEY_PREFIX + pathname;

    // Restore after paint so the restored content has real height to scroll to.
    const saved = Number(sessionStorage.getItem(key) ?? "0");
    if (saved > 0) {
      let tries = 0;
      const settle = () => {
        const target = getScroller();
        if (!target) return;
        target.scrollTop = saved;
        // Streamed/Suspense content can arrive after the first frames and grow
        // the page; keep re-applying briefly until the offset sticks.
        if (Math.abs(target.scrollTop - saved) > 2 && tries++ < 20) {
          requestAnimationFrame(settle);
        }
      };
      requestAnimationFrame(settle);
    }

    const onScroll = () => {
      const target = getScroller();
      if (target) sessionStorage.setItem(key, String(target.scrollTop));
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [pathname]);

  return null;
}

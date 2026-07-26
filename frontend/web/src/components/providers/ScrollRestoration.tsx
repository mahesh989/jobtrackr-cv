"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

/**
 * Remembers and restores scroll position for the app's inner scrollers.
 *
 * The app doesn't scroll the window. Browser scroll restoration and Next's own
 * only ever act on the window, so every navigation left our containers at 0 —
 * going to the full analysis page and pressing Back returned to the *top* of
 * the dashboard rather than the job the user had been reading.
 *
 * There is more than one scroller: the dashboard layout's main column, and the
 * job board's own list column (SmartFeed), which is the one that actually holds
 * the user's place in the feed. Any element tagged `data-scroll-container="…"`
 * takes part; the attribute value names its slot in the saved record.
 *
 * Saving uses a single capture-phase listener on `document` rather than per
 * element: scroll events don't bubble but they do capture, so containers that
 * mount later (streamed page bodies) are covered without a MutationObserver.
 *
 * Only *user* scrolling is recorded. Programmatic scrolls — ours below, the
 * router's scroll-to-top on navigation, `scrollIntoView` — would otherwise
 * overwrite a good saved offset with 0 on the way out.
 *
 * Position is keyed by pathname (not the full URL) so filter and `?job=`
 * changes within the board share one entry: those are in-place updates where
 * the user expects to stay put. sessionStorage keeps it per-tab and drops it
 * on close.
 */
const KEY_PREFIX = "jt_scroll:";
const SELECTOR = "[data-scroll-container]";

/** Give up re-applying after this long. Restoring stops early the moment it
 *  succeeds — or the moment the user touches anything — so this only bounds
 *  the streaming-content case. Generous on purpose: a cold dashboard can take
 *  the better part of ten seconds to stream its board in. */
const RESTORE_WINDOW_MS = 15000;
const TICK_MS = 50;
/** Ticks the offset must hold before we call it restored — content arriving
 *  late can grow the container after the first successful apply. */
const STABLE_TICKS = 3;
/** scrollTop is fractional on zoomed/HiDPI displays; don't chase the last px. */
const TOLERANCE = 2;

type Offsets = Record<string, number>;

function slotOf(el: HTMLElement): string {
  return el.dataset.scrollContainer || "main";
}

/** Mounted, laid-out scrollers by slot. Zero-height elements are skipped: the
 *  board renders its detail pane twice (desktop + mobile) and CSS hides one. */
function liveScrollers(): Map<string, HTMLElement> {
  const found = new Map<string, HTMLElement>();
  for (const el of document.querySelectorAll<HTMLElement>(SELECTOR)) {
    if (el.clientHeight === 0) continue;
    const slot = slotOf(el);
    if (!found.has(slot)) found.set(slot, el);
  }
  return found;
}

function readOffsets(key: string): Offsets {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Offsets = {};
    for (const [slot, top] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof top === "number" && Number.isFinite(top) && top > 0) out[slot] = top;
    }
    return out;
  } catch {
    return {};
  }
}

export function ScrollRestoration() {
  const pathname = usePathname();

  useEffect(() => {
    const key = KEY_PREFIX + pathname;
    const saved = readOffsets(key);
    // Seeded from what's on file so updating one scroller never drops the other.
    const current: Offsets = { ...saved };

    let disposed = false;
    let restoring = Object.keys(saved).length > 0;
    let userMoved = false;
    let writeTimer = 0;

    // ── restore ──────────────────────────────────────────────────────────
    // setTimeout rather than requestAnimationFrame: rAF is suspended while the
    // tab is hidden, which would leave a backgrounded restore permanently
    // half-done.
    const deadline = Date.now() + RESTORE_WINDOW_MS;
    let stable = 0;

    /** True once every saved slot is mounted and sitting at its offset. */
    function applyOnce(): boolean {
      const live = liveScrollers();
      let settled = true;
      for (const [slot, want] of Object.entries(saved)) {
        const el = live.get(slot);
        // Not mounted yet — the page body is still streaming in.
        if (!el) { settled = false; continue; }
        if (Math.abs(el.scrollTop - want) > TOLERANCE) el.scrollTop = want;
        // Still short of it: the container isn't tall enough yet.
        if (Math.abs(el.scrollTop - want) > TOLERANCE) settled = false;
      }
      return settled;
    }

    function tick() {
      if (disposed || !restoring) return;
      stable = applyOnce() ? stable + 1 : 0;
      if (stable >= STABLE_TICKS || Date.now() > deadline) {
        restoring = false;
        return;
      }
      window.setTimeout(tick, TICK_MS);
    }
    if (restoring) tick();

    // ── save ─────────────────────────────────────────────────────────────
    function flush() {
      writeTimer = 0;
      try {
        sessionStorage.setItem(key, JSON.stringify(current));
      } catch {
        // Private mode / quota — losing the position is not worth throwing over.
      }
    }

    function onScroll(e: Event) {
      if (restoring || !userMoved) return;
      const el = e.target;
      if (!(el instanceof HTMLElement) || !el.matches(SELECTOR)) return;
      current[slotOf(el)] = el.scrollTop;
      // Coalesce: scroll fires at frame rate and this is a sessionStorage write.
      if (!writeTimer) writeTimer = window.setTimeout(flush, 120);
    }

    /** Any real input means the user owns the scroll position from here on —
     *  and takes precedence over a restore still in flight. */
    function onUserInput() {
      userMoved = true;
      restoring = false;
    }

    const inputEvents = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    for (const type of inputEvents) {
      document.addEventListener(type, onUserInput, { capture: true, passive: true });
    }

    return () => {
      disposed = true;
      restoring = false;
      document.removeEventListener("scroll", onScroll, { capture: true });
      for (const type of inputEvents) {
        document.removeEventListener(type, onUserInput, { capture: true });
      }
      // A pending coalesced write would otherwise be lost on navigation.
      if (writeTimer) { window.clearTimeout(writeTimer); flush(); }
    };
  }, [pathname]);

  return null;
}

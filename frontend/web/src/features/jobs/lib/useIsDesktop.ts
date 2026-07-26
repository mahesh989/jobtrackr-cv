"use client";

import { useSyncExternalStore } from "react";

/** Tailwind's `lg` breakpoint — the point where the board switches from the
 *  mobile full-screen detail overlay to the side-by-side split. */
const DESKTOP_QUERY = "(min-width: 1024px)";

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const mq = window.matchMedia(DESKTOP_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

/**
 * Whether the viewport is at/above `lg`.
 *
 * SmartFeed mounts BoardDetailPanel twice — desktop (`hidden lg:block`) and
 * mobile (`lg:hidden`) — and CSS only hides one. Both still ran their data
 * work, so selecting a job fired the board-detail request twice (four times in
 * dev with Strict Mode) and opened two Realtime channels. This lets the hidden
 * pane skip fetching without restructuring the layout.
 *
 * The server snapshot is `true`: the desktop split is the primary layout, and
 * guessing it keeps the server and first client render identical for the common
 * case. A narrow viewport corrects itself on hydration.
 */
export function useIsDesktop(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(DESKTOP_QUERY).matches,
    () => true,
  );
}

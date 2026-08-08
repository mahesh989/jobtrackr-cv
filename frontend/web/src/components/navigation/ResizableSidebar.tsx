"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

const MIN = 200;
const MAX = 400;
const KEY = "jt_sidebar_width";

/**
 * ResizableSidebar — desktop-only draggable wrapper around the sidebar (like
 * the Claude app). Owns the sidebar width; the main content next to it already
 * flexes via `flex-1`, so it reflows automatically. Width is clamped to
 * [MIN, MAX] and persisted to localStorage. On mobile the whole thing is
 * hidden (`hidden md:flex`) — MobileNav handles that separately.
 */
export function ResizableSidebar({ children }: { children: ReactNode }) {
  // null until hydrated → render with the theme's --sidebar-width default so
  // there's no layout flash before the saved width loads.
  const [width, setWidth] = useState<number | null>(null);
  const draggingRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  // Tracks the theme's rendered `--sidebar-width` (in px) whenever `width`
  // is null, so keyboard resizing and `aria-valuenow` have a real number to
  // start from even before the sidebar has ever been dragged.
  const [measuredDefault, setMeasuredDefault] = useState(MIN);

  useEffect(() => {
    // One-time hydrate from localStorage (an external store) on mount — the
    // canonical "sync with external system" case, not a render-derived value.
    const saved = Number(localStorage.getItem(KEY));
    // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate persisted width once on mount
    if (saved >= MIN && saved <= MAX) setWidth(saved);
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setMeasuredDefault(Math.round(el.getBoundingClientRect().width));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const startDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    draggingRef.current = true;
    // Captures the pointer to this element so drag continues to track mouse,
    // touch, or pen input even once the pointer leaves the handle's bounds —
    // covers all three pointer types through one path (see onMove/onUp below,
    // which stay on `window` the same way the old mouse listeners did).
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  const reset = useCallback(() => {
    setWidth(null);
    localStorage.removeItem(KEY);
  }, []);

  // Persist exactly like the mouse-drag path (`onUp` below) does.
  const persist = useCallback((w: number) => {
    setWidth(w);
    localStorage.setItem(KEY, String(w));
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const STEP = 16;
    const current = width ?? measuredDefault;
    switch (e.key) {
      case "ArrowLeft":
        e.preventDefault();
        persist(Math.max(MIN, current - STEP));
        break;
      case "ArrowRight":
        e.preventDefault();
        persist(Math.min(MAX, current + STEP));
        break;
      case "Home":
        e.preventDefault();
        persist(MIN);
        break;
      case "End":
        e.preventDefault();
        persist(MAX);
        break;
      case "Enter":
        e.preventDefault();
        reset();
        break;
      default:
        break;
    }
  }, [width, measuredDefault, persist, reset]);

  useEffect(() => {
    function onMove(e: PointerEvent) {
      if (!draggingRef.current) return;
      setWidth(Math.min(MAX, Math.max(MIN, e.clientX)));
    }
    function onUp() {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setWidth((w) => {
        if (w) localStorage.setItem(KEY, String(w));
        return w;
      });
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    // A touch drag interrupted by the OS (e.g. an incoming call, or the
    // browser reclaiming the gesture) fires `pointercancel` instead of
    // `pointerup` — without this the drag state would stick.
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, []);

  const px = width ? `${width}px` : "var(--sidebar-width)";
  const currentWidth = width ?? measuredDefault;

  return (
    <div
      ref={containerRef}
      className="relative shrink-0 hidden md:flex md:flex-col"
      style={{ width: px, minWidth: px }}
    >
      {children}
      {/* Drag handle on the right edge. Double-click, or Enter while
          focused, resets to the default. Arrow keys resize in 16px steps;
          Home/End jump to the min/max width. */}
      <div
        onPointerDown={startDrag}
        onDoubleClick={reset}
        onKeyDown={handleKeyDown}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar (arrow keys to resize, Home/End for min/max, Enter or double-click to reset)"
        aria-valuenow={currentWidth}
        aria-valuemin={MIN}
        aria-valuemax={MAX}
        tabIndex={0}
        title="Drag to resize · double-click to reset"
        className="group absolute inset-y-0 right-0 z-20 flex w-2 translate-x-1/2 cursor-col-resize items-center justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]/60"
        style={{ touchAction: "none" }}
      >
        <span className="h-full w-px bg-transparent transition-colors group-hover:bg-[var(--brand)]/40 group-active:bg-[var(--brand)]/60 group-focus-visible:bg-[var(--brand)]/60" />
      </div>
    </div>
  );
}

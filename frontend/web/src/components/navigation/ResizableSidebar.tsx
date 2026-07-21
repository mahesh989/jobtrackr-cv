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

  useEffect(() => {
    const saved = Number(localStorage.getItem(KEY));
    if (saved >= MIN && saved <= MAX) setWidth(saved);
  }, []);

  const startDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  const reset = useCallback(() => {
    setWidth(null);
    localStorage.removeItem(KEY);
  }, []);

  useEffect(() => {
    function onMove(e: MouseEvent) {
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
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  const px = width ? `${width}px` : "var(--sidebar-width)";

  return (
    <div
      className="relative shrink-0 hidden md:flex md:flex-col"
      style={{ width: px, minWidth: px }}
    >
      {children}
      {/* Drag handle on the right edge. Double-click resets to the default. */}
      <div
        onMouseDown={startDrag}
        onDoubleClick={reset}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar (double-click to reset)"
        title="Drag to resize · double-click to reset"
        className="group absolute inset-y-0 right-0 z-20 flex w-2 translate-x-1/2 cursor-col-resize items-center justify-center"
      >
        <span className="h-full w-px bg-transparent transition-colors group-hover:bg-[var(--brand)]/40 group-active:bg-[var(--brand)]/60" />
      </div>
    </div>
  );
}

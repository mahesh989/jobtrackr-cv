"use client";

import { useEffect, useState } from "react";
import { applyTheme, getStoredTheme, THEMES, type Theme } from "@/lib/themes";
import { Button } from "@/components/ui";

/**
 * Visual theme picker. Renders a 2x2 grid of preview cards — clicking a
 * card applies the theme immediately (no save button) and persists the
 * choice to localStorage. The preview swatches mimic each theme's
 * sidebar accent bar, primary action button, and content surface so
 * users can scan the grid and pick by colour.
 */
export function ThemePickerClient() {
  const [current, setCurrent] = useState<Theme>("classic");

  useEffect(() => {
    // Mount-only read of an external system (localStorage), deferred past
    // hydration on purpose — same reasoning as DensityPickerClient.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- SSR-safe hydration read, not a sync loop
    setCurrent(getStoredTheme());
  }, []);

  function pick(theme: Theme) {
    applyTheme(theme);
    setCurrent(theme);
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {THEMES.map((t) => {
        const isActive = current === t.id;
        return (
          <Button
            key={t.id}
            type="button"
            onClick={() => pick(t.id)}
            className={`relative text-left rounded-md border transition-all p-3 group ${
              isActive
                ? "border-[var(--brand)] ring-2 ring-[var(--brand)]/30"
                : "border-border hover:border-[var(--brand)]/50"
            }`}
            style={{ background: t.preview.bg }}
          >
            {/* Mini wireframe preview */}
            <div
              className="rounded-md p-3 mb-3 flex gap-2 items-start"
              style={{ background: t.preview.surface }}
            >
              {/* Mini sidebar */}
              <div className="flex flex-col gap-1 shrink-0">
                <div
                  className="w-1 h-4 rounded-full"
                  style={{ background: t.preview.primary }}
                />
                <div className="w-1 h-2 rounded-full" style={{ background: t.preview.muted, opacity: 0.4 }} />
                <div className="w-1 h-2 rounded-full" style={{ background: t.preview.muted, opacity: 0.4 }} />
                <div className="w-1 h-2 rounded-full" style={{ background: t.preview.muted, opacity: 0.4 }} />
              </div>

              {/* Mini content */}
              <div className="flex-1 space-y-1.5">
                <div className="flex items-center gap-1">
                  <div className="h-1.5 w-3 rounded-full" style={{ background: t.preview.muted, opacity: 0.5 }} />
                  <div className="h-1.5 w-6 rounded-full" style={{ background: t.preview.muted, opacity: 0.3 }} />
                  <div className="h-1.5 w-3 rounded-full" style={{ background: t.preview.muted, opacity: 0.3 }} />
                </div>
                <div className="grid grid-cols-2 gap-1">
                  <div className="h-3 rounded-sm" style={{ background: t.preview.primary, opacity: 0.65 }} />
                  <div className="h-3 rounded-sm" style={{ background: t.preview.muted, opacity: 0.2 }} />
                </div>
                <div className="h-1.5 w-full rounded-full" style={{ background: t.preview.primary, opacity: 0.7 }} />
              </div>
            </div>

            <div className="flex items-start justify-between gap-2">
              <div>
                <p
                  className="text-[14px] font-semibold tracking-tight"
                  style={{ color: t.preview.text }}
                >
                  {t.name}
                </p>
                <p
                  className="text-[12px] mt-0.5"
                  style={{ color: t.preview.muted }}
                >
                  {t.description}
                </p>
              </div>
              {isActive && (
                <span
                  className="shrink-0 w-5 h-5 rounded-full flex items-center justify-center"
                  style={{ background: t.preview.primary }}
                  aria-label="Selected"
                >
                  <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                    <path
                      d="M2.5 6.2L4.8 8.5L9.5 3.5"
                      stroke="white"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
              )}
            </div>
          </Button>
        );
      })}
    </div>
  );
}

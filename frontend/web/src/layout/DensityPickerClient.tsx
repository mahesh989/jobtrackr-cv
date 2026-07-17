"use client";

import { useEffect, useState } from "react";
import { applyDensity, getStoredDensity, DENSITIES, type Density } from "@/lib/density";
import { Button } from "@/ui";

/**
 * Text-size / density control. Segmented control — clicking applies instantly
 * and persists to localStorage. Independent of the theme picker.
 */
export function DensityPickerClient() {
  const [current, setCurrent] = useState<Density>("comfortable");

  useEffect(() => {
    // Mount-only read of an external system (localStorage), deferred past
    // hydration on purpose: the server always renders "comfortable" (no
    // localStorage access there), and reading synchronously during the
    // first client render would risk a hydration mismatch. There's no
    // "previous render" to compare here, so the render-time-comparison
    // pattern doesn't apply — this genuinely needs to run post-hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- SSR-safe hydration read, not a sync loop
    setCurrent(getStoredDensity());
  }, []);

  function pick(d: Density) {
    applyDensity(d);
    setCurrent(d);
  }

  return (
    <div className="inline-flex rounded-xl border border-border bg-[var(--surface-2)] p-1">
      {DENSITIES.map((d) => {
        const on = current === d.id;
        return (
          <Button
            key={d.id}
            type="button"
            onClick={() => pick(d.id)}
            aria-pressed={on}
            title={d.hint}
            className={`px-4 py-2 rounded-lg text-[13px] font-semibold transition-colors ${
              on
                ? "bg-[var(--surface)] text-[var(--brand)] shadow-sm"
                : "text-text-2 hover:text-text"
            }`}
          >
            {d.name}
          </Button>
        );
      })}
    </div>
  );
}

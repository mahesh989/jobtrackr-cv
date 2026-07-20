"use client";

import { useEffect, useState } from "react";
import { applyDensity, getStoredDensity, DENSITIES, type Density } from "@/lib/density";
import { SegmentedControl } from "@/components/ui";

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
    <SegmentedControl
      options={DENSITIES.map((d) => ({ id: d.id, label: d.name, title: d.hint }))}
      value={current}
      onChange={pick}
      brandActive
    />
  );
}

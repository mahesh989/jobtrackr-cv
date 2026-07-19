"use client";

import { useState } from "react";
import { Button } from "@/components/ui";

interface QualityFlags {
  honesty_guard_notes?: string[];
  pre_filter_dropped_roles?: string[];
  honesty_risk?: { risk_level?: string; vertical_months?: number };
}

interface Props {
  flags: QualityFlags | null;
}

/**
 * Surfaces the rewrites the honesty_guard made to the tailored CV. The
 * pipeline rewrites only what's needed to keep the CV anchored to the source —
 * dates, setting descriptors, skill labels, years claims — and lists each
 * change here so the user knows exactly what changed.
 */
export function QualityFlagsCard({ flags }: Props) {
  const [open, setOpen] = useState(false);
  if (!flags) return null;
  const notes = flags.honesty_guard_notes ?? [];
  const dropped = flags.pre_filter_dropped_roles ?? [];
  const total = notes.length + dropped.length;
  if (total === 0) return null;

  return (
    <div className="rounded-lg border border-border bg-surface-2 p-4">
      <Button
        variant="default"
        size="sm"
        onClick={() => setOpen(o => !o)}
        className="flex w-full items-center justify-between text-left cursor-pointer"
      >
        <div className="flex items-center gap-2 text-sm font-medium text-text">
          <span className="text-amber" aria-hidden>✎</span>
          <span>We adjusted {total} item{total === 1 ? "" : "s"} to keep the CV honest</span>
        </div>
        <span className="text-xs text-text-3 font-medium hover:text-brand transition-colors">
          {open ? "Hide" : "Show"}
        </span>
      </Button>
      {open && (
        <ul className="mt-3 space-y-1.5 text-xs text-text-2 list-disc pl-5">
          {notes.map((n, i) => <li key={`n${i}`}>{n}</li>)}
          {dropped.map((d, i) => (
            <li key={`d${i}`}>{d}: role removed (not aligned with this role&apos;s vertical)</li>
          ))}
        </ul>
      )}
    </div>
  );
}

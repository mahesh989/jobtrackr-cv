"use client";

/**
 * Bulk-selection context shared by the SmartFeed shell (provider) and the
 * feed cards (consumers) — split out of SmartFeed.tsx (audit batch 5.2).
 */
import { createContext, useContext } from "react";

export interface JobSelectionCtx {
  selectMode: boolean;
  isSelected: (id: string) => boolean;
  toggle:     (id: string) => void;
  setMany:    (ids: string[], selected: boolean) => void;
}
export const JobSelectionContext = createContext<JobSelectionCtx | null>(null);

export function useJobSelection(): JobSelectionCtx | null {
  return useContext(JobSelectionContext);
}

// ── main component ──────────────────────────────────────────────────────


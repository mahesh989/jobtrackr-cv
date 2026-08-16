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
  /** Master-detail: open a job's detail pane. Optional — only the top-level
   *  SmartFeed provider sets it; absent means the detail pane isn't wired up
   *  (shouldn't happen in practice, but keeps this context safely reusable). */
  onOpenDetail?: (id: string) => void;
  /** Open a job's detail pane AND its Apply popup. The card's Apply button used
   *  to open the listing and stamp `applied_at` in one unconfirmed click, so a
   *  misclick permanently moved a job to Applied; routing through the pane means
   *  there is one apply flow with one confirmation step. */
  onOpenDetailAndApply?: (id: string) => void;
  /** id of the job currently shown in the detail pane, for the card's
   *  "active" highlight ring. */
  activeJobId?: string | null;
  /** True while the detail pane is open (non-flat stages only). Cards use it
   *  for the handoff's focus dimming — every card but the selected one
   *  recedes to 35% so the pane reads as the only live surface. */
  paneOpen?: boolean;
}
export const JobSelectionContext = createContext<JobSelectionCtx | null>(null);

export function useJobSelection(): JobSelectionCtx | null {
  return useContext(JobSelectionContext);
}

// ── main component ──────────────────────────────────────────────────────


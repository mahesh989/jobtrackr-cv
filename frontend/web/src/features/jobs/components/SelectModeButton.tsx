"use client";

import { X, CheckSquare, CheckCheck } from "lucide-react";

/** "Select all / Deselect all" toggle — only shown while a group is in select
 *  mode. Flips based on whether every job in the group is already selected. */
export function SelectAllButton({
  allSelected,
  onToggle,
}: {
  allSelected: boolean;
  onToggle: () => void;
}) {
  return (
    <button type="button" onClick={onToggle} className="data-select-all inline-flex items-center gap-1 text-[12px] font-medium px-3 py-1 rounded-md border border-border bg-surface text-text-2 hover:bg-[var(--surface-2)] hover:text-text transition-colors shrink-0">
      <CheckCheck className="w-3.5 h-3.5" />
      {allSelected ? "Deselect all" : "Select all"}
    </button>
  );
}

/** Bulk-select entry point — brand fill when idle, neutral outline when active. */
export function SelectModeButton({
  selectMode,
  onToggle,
}: {
  selectMode: boolean;
  onToggle: () => void;
}) {
  if (selectMode) {
    return (
      <button type="button" onClick={onToggle} className="inline-flex items-center gap-1 text-[12px] font-medium px-3 py-1 rounded-md border border-[var(--brand)] bg-[var(--brand)]/10 text-[var(--brand)] hover:bg-[var(--brand)]/20 transition-colors shrink-0">
        <X className="w-3.5 h-3.5" />
        Cancel select
      </button>
    );
  }

  return (
    <button type="button" onClick={onToggle} className="inline-flex items-center gap-1.5 text-[12px] font-medium px-3 py-1 rounded-md bg-surface text-text-2 border border-border hover:bg-[var(--surface-2)] hover:text-text shadow-sm transition-all shrink-0" title="Select multiple jobs for bulk actions">
      <CheckSquare className="w-3.5 h-3.5" />
      Select
    </button>
  );
}

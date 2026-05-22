"use client";

import { useState, useTransition } from "react";
import { Archive, Loader2, X, MailX } from "lucide-react";
import { bulkMarkPoolNoEmail, bulkArchiveJobs } from "@/lib/actions";
import { ApplicationCard, type ApplicationRow } from "./ApplicationCard";

interface Props {
  rows: ApplicationRow[];   // already filtered to pool-tab rows
}

/**
 * Renders the pool-tab cards with a per-card selection checkbox plus a
 * sticky action bar that appears when ≥1 card is selected. Bulk actions:
 *   • No email all   — stamps pool_decision_at, leaves contact_email null
 *                      → cards move to "Ready to apply"
 *   • Archive all    — stamps dismissed_at → cards move to "Archived"
 *
 * "Same email for all" is intentionally NOT offered — too risky if companies
 * differ. For email-required cases, decide per-card.
 */
export function PoolBulkBar({ rows }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, setPending]   = useState<"noemail" | "archive" | null>(null);
  const [error, setError]       = useState<string | null>(null);
  const [, startTransition]     = useTransition();

  function toggle(jobId: string) {
    setError(null);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(jobId)) next.delete(jobId);
      else next.add(jobId);
      return next;
    });
  }

  function selectAll() {
    setSelected(new Set(rows.map((r) => r.job_id)));
  }
  function clearSelection() {
    setSelected(new Set());
  }

  function runBulk(action: "noemail" | "archive") {
    if (pending || selected.size === 0) return;
    setError(null);
    setPending(action);
    const ids = Array.from(selected);
    startTransition(async () => {
      try {
        if (action === "noemail") await bulkMarkPoolNoEmail(ids);
        else                       await bulkArchiveJobs(ids);
        setSelected(new Set());
      } catch (e) {
        setError(e instanceof Error ? e.message : "Bulk action failed");
      } finally {
        setPending(null);
      }
    });
  }

  if (rows.length === 0) return null;

  const allSelected = selected.size === rows.length && rows.length > 0;

  return (
    <div className="space-y-3">
      {/* Select-all toggle row — quiet style, only visible when there are pool items */}
      <div className="flex items-center gap-2 text-[11px] text-text-3">
        <button
          onClick={allSelected ? clearSelection : selectAll}
          className="inline-flex items-center gap-1.5 hover:text-text transition-colors"
        >
          <input
            type="checkbox"
            checked={allSelected}
            onChange={() => {}}                /* handled by button click */
            className="w-3.5 h-3.5 accent-[var(--brand)] pointer-events-none"
          />
          <span>{allSelected ? "Deselect all" : "Select all"} ({rows.length})</span>
        </button>
        {selected.size > 0 && selected.size < rows.length && (
          <span className="text-text-3">· {selected.size} selected</span>
        )}
      </div>

      {/* Cards */}
      <div className="space-y-3">
        {rows.map((row) => {
          const isSelected = selected.has(row.job_id);
          return (
            <div key={row.letter_id} className="relative">
              {/* Selection checkbox overlay — top-left corner of the card */}
              <button
                onClick={() => toggle(row.job_id)}
                className="absolute top-3 left-3 z-10 w-5 h-5 rounded border border-[var(--border)] bg-[var(--surface)] flex items-center justify-center hover:border-[var(--brand)] transition-colors"
                aria-label={isSelected ? "Deselect" : "Select"}
              >
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => {}}
                  className="w-3 h-3 accent-[var(--brand)] pointer-events-none"
                />
              </button>
              {/* Indent the card body so the checkbox doesn't overlap content */}
              <div className={isSelected ? "pl-7" : ""}>
                <ApplicationCard row={row} isPool={true} />
              </div>
            </div>
          );
        })}
      </div>

      {/* Sticky bulk action bar */}
      {selected.size > 0 && (
        <div className="sticky bottom-4 z-20 mx-auto max-w-2xl rounded-md border border-[var(--border)] bg-surface shadow-lg px-3 py-2.5 flex items-center gap-3 flex-wrap">
          <span className="text-[12px] font-medium text-text">
            {selected.size} selected
          </span>
          <div className="flex items-center gap-2 ml-auto flex-wrap">
            <button
              onClick={() => runBulk("noemail")}
              disabled={pending !== null}
              className="inline-flex items-center gap-1 gh-btn text-[11px] px-2.5 py-1 disabled:opacity-40"
              title="Mark all selected as 'No email' — moves them to Ready to apply"
            >
              {pending === "noemail" ? <Loader2 className="w-3 h-3 animate-spin" /> : <MailX className="w-3 h-3" />}
              No email
            </button>
            <button
              onClick={() => runBulk("archive")}
              disabled={pending !== null}
              className="inline-flex items-center gap-1 gh-btn text-[11px] px-2.5 py-1 disabled:opacity-40"
              title="Archive all selected"
            >
              {pending === "archive" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Archive className="w-3 h-3" />}
              Archive
            </button>
            <button
              onClick={clearSelection}
              disabled={pending !== null}
              className="inline-flex items-center gap-1 text-[11px] text-text-3 hover:text-text px-2 py-1 transition-colors disabled:opacity-40"
              aria-label="Clear selection"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
          {error && (
            <p className="w-full text-[11px] text-red-600 dark:text-red-400">{error}</p>
          )}
        </div>
      )}
    </div>
  );
}

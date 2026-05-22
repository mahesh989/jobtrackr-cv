"use client";

import { useState, useMemo } from "react";
import { Send, Loader2, X, CheckCircle2, AlertCircle } from "lucide-react";
import { ApplicationCard, type ApplicationRow } from "./ApplicationCard";

interface Props {
  rows: ApplicationRow[];   // already filtered to Ready-to-email tab rows
}

type LetterStatus =
  | { state: "pending"  }
  | { state: "sending"  }
  | { state: "sent"; to: string }
  | { state: "failed"; error: string };

/**
 * Ready-to-email tab wrapper that adds bulk-send capability on top of the
 * existing per-card Send button. UX mirrors PoolBulkBar:
 *   • checkbox overlay per card
 *   • Select all (N) / Deselect all toggle
 *   • sticky action bar with 'Send N emails' button
 *   • confirmation modal listing recipients before dispatch (irreversible)
 *   • sequential POST to /api/applications/[letter_id]/send-email
 *   • per-letter status pill (sending/sent/failed) during + after batch
 *
 * Why sequential, not parallel? Gmail API quota is ~250 units/sec/user and
 * each send uses ~100 units; bursting 10+ at once risks 429s. Sequential
 * also lets us hide each card immediately on success for snappier feedback.
 *
 * Individual per-card Send buttons still work — bulk is additive.
 */
export function EmailBulkBar({ rows }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [results, setResults] = useState<Map<string, LetterStatus>>(new Map());
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  const visibleRows = useMemo(
    () => rows.filter((r) => !hidden.has(r.letter_id)),
    [rows, hidden],
  );

  function toggle(letterId: string) {
    if (sending) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(letterId)) next.delete(letterId);
      else                    next.add(letterId);
      return next;
    });
  }

  function selectAll() {
    setSelected(new Set(visibleRows.map((r) => r.letter_id)));
  }
  function clearSelection() {
    setSelected(new Set());
  }

  async function runBatch() {
    if (sending || selected.size === 0) return;
    setConfirming(false);
    setSending(true);

    // Snapshot the queue so newly selected/deselected during dispatch
    // doesn't change what's being sent.
    const queue = Array.from(selected);

    // Initialise all to pending so the bulk bar shows accurate counts.
    setResults(new Map(queue.map((id) => [id, { state: "pending" }])));

    for (const letterId of queue) {
      setResults((prev) => new Map(prev).set(letterId, { state: "sending" }));
      try {
        const res  = await fetch(`/api/applications/${letterId}/send-email`, { method: "POST" });
        const json = await res.json();
        if (!res.ok) {
          setResults((prev) => new Map(prev).set(letterId, {
            state: "failed",
            error: json.error ?? `HTTP ${res.status}`,
          }));
        } else {
          setResults((prev) => new Map(prev).set(letterId, {
            state: "sent",
            to:    json.to ?? "",
          }));
          // Slide the card out — the same revalidate that markPoolDecision
          // triggers will eventually drop it from the parent's list, but the
          // optimistic hide makes the UI feel responsive.
          setHidden((prev) => {
            const next = new Set(prev);
            next.add(letterId);
            return next;
          });
        }
      } catch (e) {
        setResults((prev) => new Map(prev).set(letterId, {
          state: "failed",
          error: e instanceof Error ? e.message : "Network error",
        }));
      }
    }

    setSending(false);
    setSelected(new Set());
  }

  if (visibleRows.length === 0 && rows.length > 0) {
    // All have been hidden by a successful batch — show a quick summary.
    const sentCount   = [...results.values()].filter((s) => s.state === "sent").length;
    const failedCount = [...results.values()].filter((s) => s.state === "failed").length;
    return (
      <div className="bg-surface border border-border rounded-md py-8 px-6 anim-in">
        <div className="flex items-center gap-2 mb-2">
          <CheckCircle2 className="w-5 h-5 text-emerald-600" />
          <p className="text-[13px] font-semibold text-text">Batch complete</p>
        </div>
        <p className="text-[12px] text-text-2">
          {sentCount} email{sentCount === 1 ? "" : "s"} sent.
          {failedCount > 0 && ` · ${failedCount} failed.`}
        </p>
        {failedCount > 0 && (
          <ul className="mt-3 space-y-1">
            {[...results.entries()]
              .filter(([, s]) => s.state === "failed")
              .map(([id, s]) => (
                <li key={id} className="text-[11px] text-red-600 dark:text-red-400">
                  {/* @ts-expect-error narrowed by filter */}
                  · {id.slice(0, 8)}: {s.error}
                </li>
              ))}
          </ul>
        )}
      </div>
    );
  }

  if (visibleRows.length === 0) return null;

  const allSelected = selected.size === visibleRows.length && visibleRows.length > 0;
  const sentSoFar   = [...results.values()].filter((s) => s.state === "sent").length;
  const totalQueue  = results.size;

  return (
    <div className="space-y-3">
      {/* Select-all row */}
      <div className="flex items-center gap-2 text-[11px] text-text-3">
        <button
          onClick={allSelected ? clearSelection : selectAll}
          disabled={sending}
          className="inline-flex items-center gap-1.5 hover:text-text transition-colors disabled:opacity-40"
        >
          <input
            type="checkbox"
            checked={allSelected}
            onChange={() => {}}
            className="w-3.5 h-3.5 accent-[var(--brand)] pointer-events-none"
          />
          <span>{allSelected ? "Deselect all" : "Select all"} ({visibleRows.length})</span>
        </button>
        {selected.size > 0 && selected.size < visibleRows.length && (
          <span className="text-text-3">· {selected.size} selected</span>
        )}
      </div>

      {/* Cards */}
      <div className="space-y-3">
        {visibleRows.map((row) => {
          const isSelected = selected.has(row.letter_id);
          const status     = results.get(row.letter_id);
          return (
            <div key={row.letter_id} className="relative">
              <button
                onClick={() => toggle(row.letter_id)}
                disabled={sending}
                className="absolute top-3 left-3 z-10 w-5 h-5 rounded border border-[var(--border)] bg-[var(--surface)] flex items-center justify-center hover:border-[var(--brand)] transition-colors disabled:opacity-40"
                aria-label={isSelected ? "Deselect" : "Select"}
              >
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => {}}
                  className="w-3 h-3 accent-[var(--brand)] pointer-events-none"
                />
              </button>
              <div className={isSelected || status ? "pl-7" : ""}>
                {/* Per-card status pill — only during/after batch send */}
                {status && (
                  <div className="absolute top-3 right-3 z-10">
                    {status.state === "sending" && (
                      <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
                        <Loader2 className="w-3 h-3 animate-spin" /> Sending
                      </span>
                    )}
                    {status.state === "failed" && (
                      <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300">
                        <AlertCircle className="w-3 h-3" /> Failed
                      </span>
                    )}
                  </div>
                )}
                <ApplicationCard row={row} isPool={false} />
                {status?.state === "failed" && (
                  <p className="mt-1 text-[11px] text-red-600 dark:text-red-400">
                    {status.error}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Sticky bulk action bar */}
      {(selected.size > 0 || sending) && (
        <div className="sticky bottom-4 z-20 mx-auto max-w-2xl rounded-md border border-[var(--border)] bg-surface shadow-lg px-3 py-2.5 flex items-center gap-3 flex-wrap">
          {sending ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin text-[var(--brand)]" />
              <span className="text-[12px] font-medium text-text">
                Sending {Math.min(sentSoFar + 1, totalQueue)} of {totalQueue}…
              </span>
            </>
          ) : (
            <>
              <span className="text-[12px] font-medium text-text">
                {selected.size} selected
              </span>
              <div className="flex items-center gap-2 ml-auto flex-wrap">
                <button
                  onClick={() => setConfirming(true)}
                  className="inline-flex items-center gap-1 gh-btn gh-btn-primary text-[11px] px-2.5 py-1"
                  title="Send the selected emails (irreversible)"
                >
                  <Send className="w-3 h-3" />
                  Send {selected.size} email{selected.size === 1 ? "" : "s"}
                </button>
                <button
                  onClick={clearSelection}
                  className="inline-flex items-center gap-1 text-[11px] text-text-3 hover:text-text px-2 py-1 transition-colors"
                  aria-label="Clear selection"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Confirmation modal */}
      {confirming && (
        <ConfirmModal
          rows={visibleRows.filter((r) => selected.has(r.letter_id))}
          onCancel={() => setConfirming(false)}
          onConfirm={runBatch}
        />
      )}
    </div>
  );
}

// ── Confirmation modal ──────────────────────────────────────────────────────

function ConfirmModal({
  rows, onCancel, onConfirm,
}: {
  rows: ApplicationRow[];
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onCancel}
    >
      <div
        className="bg-surface border border-border rounded-lg shadow-2xl max-w-lg w-full max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="px-5 py-4 border-b border-border">
          <h2 className="text-[14px] font-semibold text-text">
            Send {rows.length} email{rows.length === 1 ? "" : "s"}?
          </h2>
          <p className="text-[12px] text-text-2 mt-1">
            This dispatches via your connected email account and cannot be undone.
            Each job will be marked as applied.
          </p>
        </div>
        <div className="px-5 py-3 overflow-y-auto flex-1">
          <ul className="space-y-1.5">
            {rows.map((r) => (
              <li key={r.letter_id} className="flex items-center gap-2 text-[12px]">
                <span className="font-medium text-text truncate flex-1">
                  {r.job_title} <span className="text-text-3">@ {r.job_company}</span>
                </span>
                <span className="font-mono text-[10px] text-text-3 truncate shrink-0 max-w-[200px]">
                  {r.job_contact_email}
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div className="px-5 py-3 border-t border-border flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            className="text-[12px] text-text-2 hover:text-text px-3 py-1.5 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="inline-flex items-center gap-1 gh-btn gh-btn-primary text-[12px] px-3 py-1.5"
          >
            <Send className="w-3.5 h-3.5" />
            Send {rows.length} now
          </button>
        </div>
      </div>
    </div>
  );
}

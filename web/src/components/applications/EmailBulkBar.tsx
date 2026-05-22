"use client";

import { useState, useMemo } from "react";
import { Send, Loader2, X, CheckCircle2, AlertCircle, SkipForward } from "lucide-react";
import { ApplicationCard, type ApplicationRow } from "./ApplicationCard";
import { ComposeEmailModal } from "./ComposeEmailModal";

interface Props {
  rows: ApplicationRow[];   // already filtered to Ready-to-email tab rows
}

type LetterStatus =
  | { state: "pending"  }
  | { state: "sent"; to: string }
  | { state: "skipped" }
  | { state: "failed"; error: string };

/**
 * Ready-to-email tab wrapper. Bulk-send opens the compose/review modal for
 * EACH selected letter in sequence so the user can edit subject+body before
 * dispatch — every email is reviewed individually (no batch-blind send).
 *
 * Flow:
 *   1. User selects N cards
 *   2. Click "Review & send N emails" → confirmation modal lists recipients
 *   3. Confirm → first ComposeEmailModal opens with that letter's prefilled
 *      draft. User edits + clicks Send (POSTs /send-email) → next opens.
 *      Clicking Cancel/Close on a modal SKIPS that letter (advances without
 *      sending) so the user can drop individual rows mid-batch.
 *   4. After the last letter → batch summary card.
 *
 * Per-card Send still works (also opens the compose modal — same component).
 */
export function EmailBulkBar({ rows }: Props) {
  const [selected,   setSelected]   = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [queue,      setQueue]      = useState<string[]>([]);
  const [queueIdx,   setQueueIdx]   = useState(0);
  const [results,    setResults]    = useState<Map<string, LetterStatus>>(new Map());
  const [hidden,     setHidden]     = useState<Set<string>>(new Set());

  const inBatch = queue.length > 0 && queueIdx < queue.length;

  const visibleRows = useMemo(
    () => rows.filter((r) => !hidden.has(r.letter_id)),
    [rows, hidden],
  );

  function toggle(letterId: string) {
    if (inBatch) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(letterId)) next.delete(letterId);
      else                    next.add(letterId);
      return next;
    });
  }

  function selectAll()       { setSelected(new Set(visibleRows.map((r) => r.letter_id))); }
  function clearSelection()  { setSelected(new Set()); }

  function startQueue() {
    if (inBatch || selected.size === 0) return;
    setConfirming(false);
    const q = Array.from(selected);
    setResults(new Map(q.map((id) => [id, { state: "pending" }])));
    setQueue(q);
    setQueueIdx(0);
  }

  function advance() {
    setQueueIdx((i) => i + 1);
  }

  function handleSent(letterId: string, toEmail: string) {
    setResults((prev) => new Map(prev).set(letterId, { state: "sent", to: toEmail }));
    setHidden((prev) => {
      const next = new Set(prev);
      next.add(letterId);
      return next;
    });
    advance();
  }

  function handleSkip(letterId: string) {
    setResults((prev) => new Map(prev).set(letterId, { state: "skipped" }));
    advance();
  }

  function finishBatch() {
    setQueue([]);
    setQueueIdx(0);
    setSelected(new Set());
  }

  // ── Batch-complete summary ────────────────────────────────────────────────
  // Shown when (a) the whole queue completed and there are no visible cards
  // left, OR (b) every row was hidden by successful sends.
  const batchDone = queue.length > 0 && queueIdx >= queue.length;
  if (batchDone && visibleRows.length === 0) {
    const sent    = [...results.values()].filter((s) => s.state === "sent").length;
    const skipped = [...results.values()].filter((s) => s.state === "skipped").length;
    const failed  = [...results.values()].filter((s) => s.state === "failed").length;
    return (
      <div className="bg-surface border border-border rounded-md py-8 px-6 anim-in">
        <div className="flex items-center gap-2 mb-2">
          <CheckCircle2 className="w-5 h-5 text-emerald-600" />
          <p className="text-[13px] font-semibold text-text">Batch complete</p>
        </div>
        <p className="text-[12px] text-text-2">
          {sent} email{sent === 1 ? "" : "s"} sent.
          {skipped > 0 && ` · ${skipped} skipped.`}
          {failed  > 0 && ` · ${failed} failed.`}
        </p>
        <button
          onClick={finishBatch}
          className="mt-3 text-[11px] text-[var(--brand)] hover:underline"
        >
          Reset
        </button>
      </div>
    );
  }

  if (visibleRows.length === 0) return null;

  const allSelected = selected.size === visibleRows.length && visibleRows.length > 0;
  const currentLetterId = inBatch ? queue[queueIdx] : null;
  const currentRow = currentLetterId
    ? rows.find((r) => r.letter_id === currentLetterId) ?? null
    : null;

  return (
    <div className="space-y-3">
      {/* Select-all row */}
      <div className="flex items-center gap-2 text-[11px] text-text-3">
        <button
          onClick={allSelected ? clearSelection : selectAll}
          disabled={inBatch}
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
                disabled={inBatch}
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
              <div className="pl-7">
                {/* Per-card status pill — reflects skip / fail from a previous batch attempt */}
                {status && status.state !== "pending" && (
                  <div className="absolute top-3 right-3 z-10">
                    {status.state === "skipped" && (
                      <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
                        <SkipForward className="w-3 h-3" /> Skipped
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
      {(selected.size > 0 || inBatch) && (
        <div className="sticky bottom-4 z-20 mx-auto max-w-2xl rounded-md border border-[var(--border)] bg-surface shadow-lg px-3 py-2.5 flex items-center gap-3 flex-wrap">
          {inBatch ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin text-[var(--brand)]" />
              <span className="text-[12px] font-medium text-text">
                Reviewing {queueIdx + 1} of {queue.length}…
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
                  title="Review and send each email one at a time"
                >
                  <Send className="w-3 h-3" />
                  Review & send {selected.size} email{selected.size === 1 ? "" : "s"}
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

      {/* Confirmation modal — lists what's about to enter the review queue */}
      {confirming && (
        <ConfirmModal
          rows={visibleRows.filter((r) => selected.has(r.letter_id))}
          onCancel={() => setConfirming(false)}
          onConfirm={startQueue}
        />
      )}

      {/* Per-letter compose modal — opens for each letter in sequence */}
      {currentLetterId && currentRow && (
        <ComposeEmailModal
          key={currentLetterId}
          letterId={currentLetterId}
          jobLabel={`${currentRow.job_title}${currentRow.job_company ? ` @ ${currentRow.job_company}` : ""} · ${queueIdx + 1} of ${queue.length}`}
          onSent={(toEmail) => handleSent(currentLetterId, toEmail)}
          onClose={() => handleSkip(currentLetterId)}
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
            Review {rows.length} email{rows.length === 1 ? "" : "s"} before sending
          </h2>
          <p className="text-[12px] text-text-2 mt-1">
            Each email opens in a compose window where you can edit the subject and
            body. Closing a window skips that one without sending.
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
            Start review
          </button>
        </div>
      </div>
    </div>
  );
}

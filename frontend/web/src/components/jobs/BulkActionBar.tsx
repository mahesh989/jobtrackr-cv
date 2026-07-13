"use client";

import { Archive, Loader2, Sparkles, Star, X } from "lucide-react";

export function BulkActionBar({
  selectedCount, isAnySelectMode, progress, confirmAnalyse, bulkPending,
  onStar, onArchive, onConfirmAnalyse, onSetConfirmAnalyse, onStop,
}: {
  selectedCount: number;
  isAnySelectMode: boolean;
  progress: { done: number; total: number } | null;
  confirmAnalyse: boolean;
  bulkPending: "archive" | "star" | null;
  onStar: () => void;
  onArchive: () => void;
  onConfirmAnalyse: () => void;
  onSetConfirmAnalyse: (v: boolean) => void;
  onStop: () => void;
}) {
  if (!isAnySelectMode) return null;

  return (
    <div className="sticky bottom-4 z-30 mx-auto max-w-2xl rounded-lg border border-[var(--border)] bg-surface shadow-lg px-4 py-2.5 flex items-center gap-3 flex-wrap">
      <span className="text-[13px] font-semibold text-text">
        {selectedCount > 0 ? `${selectedCount} selected` : "Tap jobs to select"}
      </span>
      <div className="flex items-center gap-2 ml-auto flex-wrap">
        {progress ? (
          <>
            <span className="inline-flex items-center gap-1.5 text-[12px] text-text-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Analysing {progress.done}/{progress.total}…
            </span>
            <button
              onClick={onStop}
              className="inline-flex items-center gap-1.5 text-[12px] font-medium text-red-600 hover:text-red-700 border border-red-200 hover:border-red-300 bg-red-50 hover:bg-red-100 rounded-md px-2.5 py-1 transition-colors"
              title="Stop queuing new analyses — already-sent requests will still complete"
            >
              <X className="w-3.5 h-3.5" />
              Stop
            </button>
          </>
        ) : confirmAnalyse ? (
          <>
            <span className="text-[12px] text-text-2">
              Uses {selectedCount} credit{selectedCount !== 1 ? "s" : ""}
            </span>
            <button
              onClick={onConfirmAnalyse}
              className="gh-btn gh-btn-primary text-[12px] px-3 py-1 inline-flex items-center gap-1.5"
            >
              <Sparkles className="w-3.5 h-3.5" />
              Confirm — analyse {selectedCount}
            </button>
            <button
              onClick={() => onSetConfirmAnalyse(false)}
              className="text-[12px] text-text-3 hover:text-text px-2 py-1 transition-colors"
            >
              Back
            </button>
          </>
        ) : (
          <>
            {selectedCount > 0 && (
              <>
                <button
                  onClick={onStar}
                  disabled={bulkPending !== null}
                  className="inline-flex items-center gap-1.5 text-[12px] font-medium text-amber-600 hover:text-amber-700 border border-amber-200 hover:border-amber-300 bg-amber-50 hover:bg-amber-100 rounded-md px-2.5 py-1 transition-colors disabled:opacity-50"
                  title="Star selected jobs — adds to your favourites"
                >
                  {bulkPending === "star"
                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    : <Star className="w-3.5 h-3.5" />}
                  Star
                </button>
                <button
                  onClick={onArchive}
                  disabled={bulkPending !== null}
                  className="inline-flex items-center gap-1.5 text-[12px] font-medium text-text-2 hover:text-text border border-[var(--border)] hover:border-text-3 bg-[var(--surface-2)] hover:bg-[var(--surface)] rounded-md px-2.5 py-1 transition-colors disabled:opacity-50"
                  title="Archive selected jobs — hides from the main view"
                >
                  {bulkPending === "archive"
                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    : <Archive className="w-3.5 h-3.5" />}
                  Archive
                </button>
                <button
                  onClick={() => onSetConfirmAnalyse(true)}
                  disabled={bulkPending !== null}
                  className="gh-btn gh-btn-primary text-[12px] px-3 py-1 inline-flex items-center gap-1.5 disabled:opacity-50"
                  title="Analyse selected jobs — bypasses the initial gate"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  Analyse {selectedCount}
                </button>
              </>
            )}
            <button
              onClick={onStop}
              className="text-[12px] text-text-3 hover:text-text px-2 py-1 transition-colors"
            >
              Cancel
            </button>
          </>
        )}
      </div>
    </div>
  );
}

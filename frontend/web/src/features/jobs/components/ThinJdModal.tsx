"use client";

/**
 * Thin-JD explainer, shown as a popup on the dashboard rather than as an inline
 * banner.
 *
 * It was a banner sitting permanently above the board, which is the worst of
 * both worlds: big enough to push the actual jobs down the page, easy enough to
 * scroll past to be ignored. As a popup it is seen once and then gets out of
 * the way entirely.
 *
 * WHEN IT SHOWS
 * Once per login. "Don't show me again" suppresses it for the rest of the
 * current browser session and it returns on the next fresh sign-in — the
 * suppression lives in sessionStorage (which dies with the tab) and the login
 * page clears the key on the way in, so signing out and back in within the same
 * tab still counts as fresh. Deliberately NOT localStorage: the thin-JD count
 * changes as jobs are scraped, and a permanently dismissed explainer would mean
 * a user who fixed the problem in week one never hears about it again in week
 * four.
 */

import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { FileWarning, X } from "lucide-react";
import { Button } from "@/components/ui";

/** Exported so the login page can clear it — see the module note. */
export const THIN_JD_HIDE_KEY = "jobtrackr:thinJdModal:hidden";

const subscribeNoop = () => () => {};

/** Reads the suppression flag. Falls open on storage errors (private mode):
 *  a user who can't be told twice should at least be told once. */
function readCanShow(): boolean {
  try { return sessionStorage.getItem(THIN_JD_HIDE_KEY) !== "1"; }
  catch { return true; }
}

export function ThinJdModal({ count }: { count: number }) {
  // Both of these are "what does the client know that the server doesn't".
  // useSyncExternalStore is the right shape for that: the server snapshot
  // renders nothing, the client snapshot reads sessionStorage — no
  // setState-in-effect, and therefore no cascading render on every dashboard
  // load. The store never emits; the value is read once per mount, which is
  // exactly the lifetime this flag has.
  const canShow = useSyncExternalStore(subscribeNoop, readCanShow, () => false);

  const [closed, setClosed]     = useState(false);
  const [dontShow, setDontShow] = useState(false);

  const open = canShow && !closed && count > 0;

  function close() {
    if (dontShow) {
      try { sessionStorage.setItem(THIN_JD_HIDE_KEY, "1"); } catch { /* storage disabled */ }
    }
    setClosed(true);
  }

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (dontShow) {
        try { sessionStorage.setItem(THIN_JD_HIDE_KEY, "1"); } catch { /* storage disabled */ }
      }
      setClosed(true);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, dontShow]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-text/40 backdrop-blur-sm" onClick={close} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="thin-jd-title"
        className="relative w-full max-w-lg rounded-2xl border border-[var(--border)] bg-surface p-6 shadow-xl"
      >
        <button
          type="button"
          onClick={close}
          aria-label="Close"
          className="absolute right-3 top-3 rounded-full p-1.5 text-text-3 hover:bg-[var(--surface-2)] hover:text-text transition-colors"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="flex gap-3 items-start pr-6">
          <FileWarning className="w-5 h-5 shrink-0 mt-0.5 text-[var(--amber)]" />
          <div className="min-w-0">
            <p id="thin-jd-title" className="text-lead font-semibold text-text">
              {count} job{count !== 1 ? "s have" : " has"} an incomplete job description
            </p>
            <p className="mt-1 text-body text-text-2">
              Jobs without a full description can&apos;t be analysed. Here&apos;s how to fix them:
            </p>
          </div>
        </div>

        <ol className="mt-4 space-y-2 text-label text-text-2 list-decimal list-inside">
          <li>Click <span className="font-medium text-text">···</span> on the job card → <span className="font-medium text-text">Edit JD</span></li>
          <li>Open the job posting link shown in the editor</li>
          <li>Copy and paste the full job description into the text box</li>
          <li>Optionally add the recruiter email to apply directly by email</li>
          <li>Hit <span className="font-medium text-text">Save</span> — analysis starts automatically</li>
        </ol>

        <div className="mt-6 flex items-center justify-between gap-4 border-t border-[var(--border)] pt-4">
          <label className="flex items-center gap-2 text-label text-text-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={dontShow}
              onChange={(e) => setDontShow(e.target.checked)}
              className="w-4 h-4 rounded border-border accent-[var(--brand)] cursor-pointer"
            />
            Don&apos;t show me again
          </label>
          <Button variant="brand" size="sm" onClick={close} className="rounded-full px-5">
            Close
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

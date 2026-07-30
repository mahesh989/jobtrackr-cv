"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import { CheckCircle2, AlertTriangle, X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

interface RunSnapshot {
  id:            string;
  profile_id:    string;
  profile_name:  string;
  status:        "running" | "completed" | "failed";
  current_stage: string | null;
  jobs_saved:    number;
  finished_at:   string | null;
}

interface Notice {
  id:      string;
  kind:    "success" | "error";
  title:   string;
  sub:     string;
  href:    string;
  ctaText: string;
}

// Run-status changes arrive via Supabase Realtime (postgres_changes on
// run_logs — see migration 052), so there's no steady polling. A slow backstop
// poll only covers the rare dropped event and seeds initial state on mount;
// it pauses while the tab is hidden.
//
// CV-analysis runs deliberately do NOT notify here: the board's progress popup
// already reports completion in place, and the notification's router.refresh()
// was re-rendering the dashboard mid-run, which is what scrolled the page back
// to the top while an analysis was in flight.
// Realtime is the primary path and has proven reliable, so this only has to
// cover a genuinely dropped event. At 20s it was re-hitting a ~1s endpoint
// three times a minute on every open tab for the entire time the app was
// open — far more traffic than a safety net warrants. 3 minutes still catches
// a missed event well within the time it takes a pipeline run to matter, and
// the visibilitychange handler polls immediately on tab focus regardless.
const BACKSTOP_MS = 180000; // safety-net poll, visible tabs only

// Rendered as a centered popup card (same pattern as ThinJdModal) rather than
// a corner toast — a fetch that just saved jobs is worth a beat of the user's
// attention, not something to catch out of the corner of an eye. Multiple
// completions queue and show one at a time instead of stacking.
export function RunNotifier({ isAdmin = false }: { isAdmin?: boolean }) {
  const [queue, setQueue] = useState<Notice[]>([]);
  const prev   = useRef<Record<string, string>>({});
  const seeded = useRef(false);
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;

    function schedule(delay: number) {
      if (cancelled || document.hidden) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(poll, delay);
    }

    function pushNotice(notice: Notice) {
      setQueue((q) => (q.some((x) => x.id === notice.id) ? q : [...q, notice]));
    }

    async function poll() {
      // Guard against overlapping runs (e.g. a Realtime event or a
      // visibilitychange firing while a request is already in flight).
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const res = await fetch("/api/user/runs", { cache: "no-store" });
        if (!res.ok) return;
        const { runs }: { runs: RunSnapshot[] } = await res.json();
        if (cancelled) return;

        const next: Record<string, string> = {};
        for (const r of runs) next[r.id] = r.status;

        // First poll: don't fire notices for transitions we missed before mount.
        if (!seeded.current) {
          prev.current = next;
          seeded.current = true;
          return;
        }

        let anyTransition = false;
        for (const r of runs) {
          const was = prev.current[r.id];
          if (was === "running" && r.status !== "running") {
            anyTransition = true;
            const isSuccess = r.status === "completed";
            const noticeId  = `${r.id}:${r.status}`;
            const notice: Notice = {
              id:      noticeId,
              kind:    isSuccess ? "success" : "error",
              title:   isSuccess
                ? `${r.jobs_saved} new ${r.jobs_saved === 1 ? "job" : "jobs"} saved`
                : `${r.profile_name} — pipeline failed`,
              sub:     isSuccess
                ? `Fetched for "${r.profile_name}". Take a look, or keep going.`
                : "Something went wrong while fetching jobs for this profile.",
              // Run history is an admin-only surface — general users land on
              // the profile's job board instead.
              href:    isSuccess || !isAdmin
                ? `/profiles/${r.profile_id}/jobs`
                : `/profiles/${r.profile_id}/runs`,
              ctaText: isSuccess ? "View saved jobs" : isAdmin ? "View run history" : "Open profile",
            };
            pushNotice(notice);
          }
        }

        prev.current = next;

        // Trigger a server refresh so the page the user is sitting on
        // updates its server-rendered state (job counts, isRunning, etc.)
        if (anyTransition) router.refresh();
      } catch {
        /* silent */
      } finally {
        inFlight = false;
        // Backstop only — Realtime is the primary path. schedule() no-ops when
        // the tab is hidden.
        schedule(BACKSTOP_MS);
      }
    }

    // Primary path: Supabase Realtime pushes run_logs changes the instant the
    // worker writes them. RLS at the broadcast layer restricts delivery to this
    // user's rows. We act only on a flip to a terminal status, then run the
    // same enrich-and-notify pass as the backstop (the Realtime payload lacks
    // the joined profile name, so we re-fetch the enriched feed).
    const supabase = createClient();
    const channel = supabase
      .channel("run_logs:user")
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "run_logs" },
        (payload) => {
          const status = (payload.new as { status?: string }).status;
          if (status === "completed" || status === "failed") poll();
        },
      )
      .subscribe();

    // Pause the backstop poll when the tab is hidden; resume (and poll once)
    // when it returns. Realtime keeps delivering notices while hidden.
    function onVisibility() {
      if (document.hidden) {
        if (timer) { clearTimeout(timer); timer = null; }
      } else {
        poll();
      }
    }

    poll();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      supabase.removeChannel(channel);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [router, isAdmin]);

  const active = queue[0];

  useEffect(() => {
    if (!active) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setQueue((q) => q.slice(1));
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [active]);

  if (!active) return null;

  function dismiss() {
    setQueue((q) => q.slice(1));
  }

  const isSuccess = active.kind === "success";

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-text/40 backdrop-blur-sm" onClick={dismiss} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="run-notice-title"
        className="relative w-full max-w-md rounded-2xl border border-[var(--border)] bg-surface p-6 shadow-xl"
      >
        <button
          type="button"
          onClick={dismiss}
          aria-label="Close"
          className="absolute right-3 top-3 rounded-full p-1.5 text-text-3 hover:bg-[var(--surface-2)] hover:text-text transition-colors"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="flex gap-3 items-start pr-6">
          {isSuccess ? (
            <CheckCircle2 className="w-5 h-5 shrink-0 mt-0.5 text-green-700" />
          ) : (
            <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5 text-red-700" />
          )}
          <div className="min-w-0">
            <p id="run-notice-title" className="text-lead font-semibold text-text">
              {active.title}
            </p>
            <p className="mt-1 text-body text-text-2">{active.sub}</p>
          </div>
        </div>

        <div className="mt-6 flex items-center justify-end gap-2 border-t border-[var(--border)] pt-4">
          <button
            type="button"
            onClick={dismiss}
            className="rounded-full px-4 py-2 text-label font-medium text-text-2 hover:bg-[var(--surface-2)] transition-colors"
          >
            Dismiss
          </button>
          <Link
            href={active.href}
            onClick={dismiss}
            className={`rounded-full px-5 py-2 text-label font-semibold transition-colors ${
              isSuccess
                ? "bg-green-light text-green-700 hover:brightness-95"
                : "bg-red-light text-red-700 hover:brightness-95"
            }`}
          >
            {active.ctaText}
          </Link>
        </div>
      </div>
    </div>,
    document.body,
  );
}

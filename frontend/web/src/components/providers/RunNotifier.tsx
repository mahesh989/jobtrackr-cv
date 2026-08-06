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
  started_at:    string;
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

// Run-status changes are supposed to arrive via Supabase Realtime
// (postgres_changes on run_logs — see migration 052), but in practice the
// channel reports SUBSCRIBED and then never delivers a single event for this
// table (verified directly: a real run progressed through several stages and
// completed with zero postgres_changes payloads received) — the same
// unreliable-Realtime issue useJobRunStatus.ts already works around with its
// own backstop poll. So polling is the primary path here, not a backstop:
// every ACTIVE_POLL_MS while a run is known to be running (matches
// LiveRunStatus's per-profile cadence), falling back to the slow BACKSTOP_MS
// cadence the rest of the time. The Realtime subscription is kept as a free
// fast-path in case it ever starts working, not relied on.
const ACTIVE_POLL_MS = 4000;   // while a run is running, visible tabs only
const BACKSTOP_MS    = 180000; // idle safety-net poll, visible tabs only

// Rendered as a centered popup card (same pattern as ThinJdModal) rather than
// a corner toast — a fetch that just saved jobs is worth a beat of the user's
// attention, not something to catch out of the corner of an eye. Multiple
// completions queue and show one at a time instead of stacking.
//
// Also renders an inline "Pipeline running" banner (same look as the
// per-profile LiveRunStatus banner) wherever this is mounted in the layout,
// so a run started on one profile page is still visible while the user is
// elsewhere in the dashboard. It disappears the instant the run leaves
// "running" — the completion popup is what tells the user it finished, so the
// banner doesn't need its own lingering "done" state.
export function RunNotifier({ isAdmin = false }: { isAdmin?: boolean }) {
  const [queue, setQueue]         = useState<Notice[]>([]);
  const [activeRun, setActiveRun] = useState<RunSnapshot | null>(null);
  const [elapsed, setElapsed]     = useState(0);
  const [stopping, setStopping]   = useState(false);
  const prev   = useRef<Record<string, string>>({});
  const seeded = useRef(false);
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;
    let running  = false; // updated at the end of each poll(); drives the next delay
    // Set by the run-started event below. The enqueue route only pushes a
    // BullMQ job and returns — run_logs doesn't flip to "running" until the
    // worker actually picks it up, which can lag the click by a few seconds
    // (RunNowButton gives its OWN polling a matching 6s grace for the same
    // reason). Without this, the immediate poll() triggered by the event
    // would usually find nothing yet, leave `running` false, and schedule()
    // would fall right back to the 180s cadence — defeating the point of
    // reacting to the event at all.
    let forceActiveUntil = 0;

    function schedule() {
      if (cancelled || document.hidden) return;
      if (timer) clearTimeout(timer);
      const active = running || Date.now() < forceActiveUntil;
      timer = setTimeout(poll, active ? ACTIVE_POLL_MS : BACKSTOP_MS);
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

        // Most-recently-started running row, if any — shown as the top banner
        // regardless of whether this is the first poll or a later one.
        const stillRunning = runs.find((r) => r.status === "running") ?? null;
        setActiveRun(stillRunning);
        running = !!stillRunning;

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
        // schedule() no-ops when the tab is hidden.
        schedule();
      }
    }

    // Fast-path only (see note above on why this isn't relied upon): if
    // Realtime ever does deliver, react immediately instead of waiting for
    // the next poll tick.
    const supabase = createClient();
    const channel = supabase
      .channel("run_logs:user")
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "run_logs" },
        () => poll(),
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

    // RunNowButton fires this the instant its POST succeeds. Without it, a
    // run started while sitting on a page other than the profile's own would
    // wait for the next BACKSTOP_MS tick (up to 180s) before this banner —
    // the only thing showing "Pipeline running" outside that one profile
    // page — noticed. Same-tab only (a plain window event), which is exactly
    // the case that matters: cross-tab starts still fall back to the poll.
    function onRunStarted() {
      // 30s covers worker pickup latency (normally 1-3s) without keeping the
      // fast cadence alive if the run never actually starts — e.g. the job is
      // dropped, or the worker is down. Once the row does appear, `running`
      // takes over and this window stops mattering.
      forceActiveUntil = Date.now() + 30_000;
      poll();
    }

    poll();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("jobtrackr:run-started", onRunStarted);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      supabase.removeChannel(channel);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("jobtrackr:run-started", onRunStarted);
    };
  }, [router, isAdmin]);

  // Local 1s ticker for the elapsed-seconds display — independent of poll
  // cadence, which is event-driven rather than steady.
  const runId     = activeRun?.id ?? null;
  const startedAt = activeRun?.started_at ?? null;
  useEffect(() => {
    if (!startedAt) {
      // Branch of this same timer-setup effect (no run → no ticker), not a
      // standalone sync-on-render.
      // eslint-disable-next-line react-hooks/set-state-in-effect -- branch of a real polling-interval effect
      setElapsed(0);
      return;
    }
    setStopping(false);
    const started = new Date(startedAt).getTime();
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - started) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [runId, startedAt]);

  async function handleStop() {
    if (!activeRun || stopping) return;
    setStopping(true);
    try {
      const res = await fetch(`/api/profiles/${activeRun.profile_id}/runs`, { method: "DELETE" });
      if (res.ok) {
        setActiveRun(null);
        router.refresh();
      } else {
        setStopping(false);
      }
    } catch {
      setStopping(false);
    }
  }

  const active = queue[0];

  useEffect(() => {
    if (!active) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setQueue((q) => q.slice(1));
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [active]);

  function dismiss() {
    setQueue((q) => q.slice(1));
  }

  const isSuccess = active?.kind === "success";

  return (
    <>
      {activeRun && (
        <div className="px-4 sm:px-6 pt-4 anim-in">
          <div className={`h-0.5 rounded-t-md ${stopping ? "bg-[var(--border)]" : "pipeline-bar"}`} />
          <div className="border border-t-0 border-[var(--brand)]/20 bg-[var(--blue-light)]/60 rounded-b-md px-4 py-3 flex items-center justify-between gap-4">
            <div className="flex items-center gap-3 min-w-0">
              <span className="relative flex h-2.5 w-2.5 shrink-0">
                <span className={`absolute inline-flex h-full w-full rounded-full bg-[var(--brand)] opacity-75 ${stopping ? "" : "dot-ping"}`} />
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-[var(--brand)]" />
              </span>
              <div className="min-w-0">
                <p className="text-body font-semibold text-[var(--brand)] truncate">
                  {stopping ? "Stopping…" : `Pipeline running — ${activeRun.profile_name}`}
                </p>
                <p className="text-caption text-text-2 mt-0.5">
                  {stopping
                    ? "Finishing current stage, then stopping"
                    : `${activeRun.current_stage ?? "Starting"}${elapsed > 0 ? ` · ${elapsed}s` : "…"}`}
                </p>
              </div>
            </div>
            <button
              onClick={handleStop}
              disabled={stopping}
              title="Stop this run"
              className="shrink-0 flex items-center gap-1.5 px-2.5 py-1 rounded-md text-label font-medium border border-[var(--red)]/30 text-[var(--red)] bg-[var(--surface)] hover:bg-[var(--red-light)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {stopping ? (
                <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              ) : (
                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="4" y="4" width="16" height="16" rx="2" />
                </svg>
              )}
              {stopping ? "Stopping" : "Stop"}
            </button>
          </div>
        </div>
      )}

      {active && createPortal(
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
                  {active!.title}
                </p>
                <p className="mt-1 text-body text-text-2">{active!.sub}</p>
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
                href={active!.href}
                onClick={dismiss}
                className={`rounded-full px-5 py-2 text-label font-semibold transition-colors ${
                  isSuccess
                    ? "bg-green-light text-green-700 hover:brightness-95"
                    : "bg-red-light text-red-700 hover:brightness-95"
                }`}
              >
                {active!.ctaText}
              </Link>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
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

/** A CV-analysis run (analysis_runs), as served by /api/user/analysis-runs. */
interface AnalysisSnapshot {
  id:                   string;
  job_id:               string;
  job_title:            string;
  company:              string | null;
  status:               string;
  match_score:          number | null;
  tailored_match_score: number | null;
}

/** analysis_runs rows are inserted `pending` and only flip to `running` once a
 *  worker picks them up, so both count as in-flight for transition detection. */
function isAnalysisActive(status: string | undefined): boolean {
  return status === "pending" || status === "running";
}

interface Toast {
  id:    string;
  kind:  "success" | "error";
  title: string;
  sub:   string;
  href:  string;
}

// Run-status changes arrive via Supabase Realtime (postgres_changes on
// run_logs — see migration 052), so there's no steady polling. A slow backstop
// poll only covers the rare dropped event and seeds initial state on mount;
// it pauses while the tab is hidden (Realtime still pushes instant toasts
// there). Previously this was a fixed 3s heartbeat that ran forever regardless
// of activity — ~1,200 needless requests/hour/tab.
const BACKSTOP_MS = 20000; // safety-net poll, visible tabs only
const TOAST_MS    = 8000;

export function RunNotifier({ isAdmin = false }: { isAdmin?: boolean }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const prev   = useRef<Record<string, string>>({});
  const seeded = useRef(false);
  const prevAnalysis   = useRef<Record<string, string>>({});
  const seededAnalysis = useRef(false);
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;
    let analysisInFlight = false;
    const timeoutHandles: ReturnType<typeof setTimeout>[] = [];

    function schedule(delay: number) {
      if (cancelled || document.hidden) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(pollAll, delay);
    }

    function pollAll() {
      poll();
      pollAnalysis();
    }

    function pushToast(toast: Toast) {
      setToasts((t) => (t.some((x) => x.id === toast.id) ? t : [...t, toast]));
      const h = setTimeout(() => {
        setToasts((t) => t.filter((x) => x.id !== toast.id));
      }, TOAST_MS);
      timeoutHandles.push(h);
    }

    /** CV-analysis runs. Mirrors poll() but for analysis_runs, which previously
     *  had no notifier at all — a finished analysis changed nothing on screen
     *  until the user manually refreshed. */
    async function pollAnalysis() {
      if (cancelled || analysisInFlight) return;
      analysisInFlight = true;
      try {
        const res = await fetch("/api/user/analysis-runs", { cache: "no-store" });
        if (!res.ok) return;
        const { runs }: { runs: AnalysisSnapshot[] } = await res.json();
        if (cancelled) return;

        const next: Record<string, string> = {};
        for (const r of runs) next[r.id] = r.status;

        // First pass seeds only — don't toast for runs that finished before mount.
        if (!seededAnalysis.current) {
          prevAnalysis.current = next;
          seededAnalysis.current = true;
          return;
        }

        let anyTransition = false;
        for (const r of runs) {
          const was = prevAnalysis.current[r.id];
          if (!isAnalysisActive(was) || isAnalysisActive(r.status)) continue;
          anyTransition = true;
          const isSuccess = r.status === "completed";
          const lift =
            r.match_score != null && r.tailored_match_score != null
              ? `ATS ${r.match_score} → ${r.tailored_match_score}`
              : "Click to view the result";
          pushToast({
            id:    `analysis:${r.id}:${r.status}`,
            kind:  isSuccess ? "success" : "error",
            title: isSuccess
              ? `${r.job_title} — analysis complete`
              : `${r.job_title} — analysis failed`,
            sub:   isSuccess ? lift : "Click to open the job",
            // Deep-links straight into the board's detail pane for that job.
            href:  `/dashboard?job=${r.job_id}`,
          });
        }

        prevAnalysis.current = next;
        if (anyTransition) router.refresh();
      } catch {
        /* silent */
      } finally {
        analysisInFlight = false;
      }
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

        // First poll: don't fire toasts for transitions we missed before mount.
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
            const toastId   = `${r.id}:${r.status}`;
            const toast: Toast = {
              id:    toastId,
              kind:  isSuccess ? "success" : "error",
              title: isSuccess
                ? `${r.profile_name} — ${r.jobs_saved} new ${r.jobs_saved === 1 ? "job" : "jobs"}`
                : `${r.profile_name} — pipeline ${r.status}`,
              // Run history is an admin-only surface — general users land on
              // the profile's job board instead.
              sub:   isSuccess ? "Click to view feed"
                   : isAdmin   ? "Click to view run history"
                   :             "Click to open the profile",
              href:  isSuccess || !isAdmin
                ? `/profiles/${r.profile_id}/jobs`
                : `/profiles/${r.profile_id}/runs`,
            };
            pushToast(toast);
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
    // same enrich-and-toast pass as the backstop (the Realtime payload lacks
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

    // Same primary path for CV analysis. RLS restricts delivery to this user's
    // rows; the payload lacks the job title, so a terminal flip triggers the
    // enriched re-fetch above.
    const analysisChannel = supabase
      .channel("analysis_runs:user")
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "analysis_runs" },
        (payload) => {
          const status = (payload.new as { status?: string }).status;
          if (status === "completed" || status === "failed") pollAnalysis();
        },
      )
      .subscribe();

    // Pause the backstop poll when the tab is hidden; resume (and poll once)
    // when it returns. Realtime keeps delivering toasts while hidden.
    function onVisibility() {
      if (document.hidden) {
        if (timer) { clearTimeout(timer); timer = null; }
      } else {
        pollAll();
      }
    }

    pollAll();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      supabase.removeChannel(channel);
      supabase.removeChannel(analysisChannel);
      document.removeEventListener("visibilitychange", onVisibility);
      for (const h of timeoutHandles) clearTimeout(h);
    };
  }, [router, isAdmin]);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-[calc(100vw-2rem)]">
      {toasts.map((t) => (
        <Link
          key={t.id}
          href={t.href}
          className={`block w-80 rounded-md border px-4 py-3 shadow-lg anim-in transition-transform hover:-translate-y-0.5 ${
            t.kind === "success"
              ? "border-[#1A7F37]/30 bg-[#DAFBE1] text-[#1A7F37]"
              : "border-[#CF222E]/30 bg-[#FFEBE9] text-[#CF222E]"
          }`}
        >
          <div className="flex items-start gap-2.5">
            {t.kind === "success" ? (
              <svg className="w-4 h-4 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              <svg className="w-4 h-4 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M5 19h14a2 2 0 001.84-2.75L13.74 4a2 2 0 00-3.48 0L3.16 16.25A2 2 0 005 19z" />
              </svg>
            )}
            <div className="min-w-0">
              <div className="text-body font-semibold truncate">{t.title}</div>
              <div className="text-caption mt-0.5 opacity-80">{t.sub}</div>
            </div>
          </div>
        </Link>
      ))}
    </div>
  );
}

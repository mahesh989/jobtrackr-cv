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
// it pauses while the tab is hidden.
//
// CV-analysis runs deliberately do NOT toast here: the board's progress popup
// already reports completion in place, and the toast's router.refresh() was
// re-rendering the dashboard mid-run, which is what scrolled the page back to
// the top while an analysis was in flight.
// Realtime is the primary path and has proven reliable, so this only has to
// cover a genuinely dropped event. At 20s it was re-hitting a ~1s endpoint
// three times a minute on every open tab for the entire time the app was
// open — far more traffic than a safety net warrants. 3 minutes still catches
// a missed event well within the time it takes a pipeline run to matter, and
// the visibilitychange handler polls immediately on tab focus regardless.
const BACKSTOP_MS = 180000; // safety-net poll, visible tabs only
const TOAST_MS    = 8000;

export function RunNotifier({ isAdmin = false }: { isAdmin?: boolean }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const prev   = useRef<Record<string, string>>({});
  const seeded = useRef(false);
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;
    const timeoutHandles: ReturnType<typeof setTimeout>[] = [];

    function schedule(delay: number) {
      if (cancelled || document.hidden) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(poll, delay);
    }

    function pushToast(toast: Toast) {
      setToasts((t) => (t.some((x) => x.id === toast.id) ? t : [...t, toast]));
      const h = setTimeout(() => {
        setToasts((t) => t.filter((x) => x.id !== toast.id));
      }, TOAST_MS);
      timeoutHandles.push(h);
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

    // Pause the backstop poll when the tab is hidden; resume (and poll once)
    // when it returns. Realtime keeps delivering toasts while hidden.
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

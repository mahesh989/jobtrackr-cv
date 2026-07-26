"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { RunStatus } from "@/lib/constants";

/** A run occupies the board until it reaches a terminal status. `pending` counts
 *  as active — the row is inserted as `pending` and only flips to `running` once
 *  a worker picks it up, so treating it as idle would blank the UI for the first
 *  seconds of every analysis. */
function isActive(status: string | null | undefined): boolean {
  return status === RunStatus.PENDING || status === RunStatus.RUNNING;
}

/** Channel topics must be unique per subscription. `createBrowserClient`
 *  memoises the client, so `channel(topic)` hands back an existing channel when
 *  one with that topic is still registered — and calling `.on()` on a channel
 *  that has already subscribed throws "cannot add postgres_changes callbacks
 *  after subscribe()". That happens whenever this effect re-runs before the
 *  async removeChannel() settles: React Strict Mode's double-mount in dev, and
 *  switching between jobs in production. A per-subscription suffix sidesteps
 *  the shared registry entirely. */
let channelSeq = 0;

/**
 * Live analysis-run status for one job, sourced from the `analysis_runs` row
 * over Supabase Realtime rather than from component state.
 *
 * This is the fix for "I can't tell whether it's running": the previous
 * indicator was a local boolean cleared the moment the enqueue POST resolved,
 * so it vanished ~1s into a 1–2 minute pipeline and did not survive closing the
 * pane, selecting another job, or a refresh. Reading the database instead means
 * the state is correct no matter what the user does, and it self-corrects if a
 * run is started from another tab or device.
 *
 * `initialStatus` seeds from the server-rendered row so an in-flight run shows
 * immediately on mount, before any Realtime event arrives.
 *
 * `onSettled` fires when there is new content for the caller to pick up. That
 * is NOT just "the run finished": the orchestrator calls mark_run_completed()
 * as soon as the tailored CV is scored, then triggers the auto cover letter,
 * whose 3-pass generation runs as a DETACHED background task and lands in
 * `cover_letters` a minute or two later. Firing only on the run's terminal
 * status therefore refreshed the pane at the one moment the letter was
 * guaranteed to be missing — which is why the Cover letter and More tabs never
 * showed up without a manual page refresh. So we also watch `cover_letters`
 * for this job and fire again when a letter lands.
 */
export function useJobRunStatus(
  jobId: string,
  initialStatus: string | null,
  onSettled?: () => void,
  initialRunId: string | null = null,
): {
  status: string | null;
  running: boolean;
  /** Per-step state from analysis_runs.step_status, for the progress panel.
   *  Null until the first Realtime event — the server-rendered seed carries the
   *  run's status but not its steps. */
  steps: Record<string, string> | null;
  /** Id of the run this status describes — needed to cancel it. Seeded from the
   *  server-rendered latest run, then kept current by Realtime (a re-analyse
   *  creates a NEW row, so the seed goes stale the moment one starts). */
  runId: string | null;
} {
  const [status, setStatus] = useState<string | null>(initialStatus);
  const [steps, setSteps] = useState<Record<string, string> | null>(null);
  const [runId, setRunId] = useState<string | null>(initialRunId);

  // Re-seed when the pane switches to a different job. BoardDetailPanel keys on
  // job.id so this normally remounts; seeding defensively keeps the hook correct
  // if it is ever reused without a key. Uses the derive-state-during-render
  // pattern (as SmartFeed does for hiddenIds) — refs may not be touched here.
  const [seededFor, setSeededFor] = useState(jobId);
  if (seededFor !== jobId) {
    setSeededFor(jobId);
    setStatus(initialStatus);
    setSteps(null);
    setRunId(initialRunId);
  }

  // Latest-callback ref so an inline closure from the parent doesn't churn the
  // subscription on every render.
  const settledRef = useRef(onSettled);
  useEffect(() => { settledRef.current = onSettled; }, [onSettled]);

  useEffect(() => {
    // Scoped per subscription, so it resets naturally when the job changes.
    // Guards the settle callback against duplicate or replayed events.
    const settledRunIds = new Set<string>();

    const supabase = createClient();
    const channel = supabase
      .channel(`job-detail:${jobId}:${++channelSeq}`)
      .on(
        "postgres_changes",
        {
          event:  "*",
          schema: "public",
          table:  "analysis_runs",
          filter: `job_id=eq.${jobId}`,
        },
        (payload) => {
          const row = payload.new as {
            id?: string;
            status?: string;
            step_status?: Record<string, string> | null;
          } | null;
          if (!row?.status) return;
          setStatus(row.status);
          if (row.id) setRunId(row.id);
          if (row.step_status && typeof row.step_status === "object") {
            setSteps(row.step_status);
          }
          const terminal =
            row.status === RunStatus.COMPLETED || row.status === RunStatus.FAILED;
          if (terminal && row.id && !settledRunIds.has(row.id)) {
            settledRunIds.add(row.id);
            settledRef.current?.();
          }
        },
      )
      .on(
        "postgres_changes",
        {
          event:  "*",
          schema: "public",
          table:  "cover_letters",
          filter: `job_id=eq.${jobId}`,
        },
        (payload) => {
          // The letter is written in passes; only the finished text unlocks the
          // Cover letter and More tabs, so anything earlier is not worth a
          // refetch. No once-per-row guard here: a regenerate legitimately
          // completes the same row twice.
          const row = payload.new as { pass_3_final?: string | null } | null;
          if (row?.pass_3_final) settledRef.current?.();
        },
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [jobId]);

  return { status, running: isActive(status), steps, runId };
}

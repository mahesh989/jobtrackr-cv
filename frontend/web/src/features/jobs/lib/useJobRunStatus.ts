"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
 * Cross-instance "a run just started" bridge, keyed by job id.
 *
 * The card in the board list and the detail-pane header each call this hook
 * separately, so they hold INDEPENDENT state for the very same run. Realtime
 * eventually tells both, but until the first event lands the component that
 * did not start the run knows nothing — which is how one job could read
 * "Analysing…" on its card and still offer "Analyse this job" in the panel
 * beside it, for the same click.
 *
 * Publishing the new run id here flips every mounted instance for that job at
 * once. It is deliberately module-level rather than context: the two consumers
 * live in different subtrees, and this is a short-lived hand-off that Realtime
 * takes over from within a tick or two.
 */
const startedRuns = new Map<string, string>();
const startListeners = new Set<() => void>();

function publishStarted(jobId: string, runId: string) {
  startedRuns.set(jobId, runId);
  startListeners.forEach((l) => l());
}

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
  /** Call with the run_id the enqueue POST returned, to mark this job as running
   *  immediately.
   *
   *  Without it there is a gap: callers used to hold their own `submitting`
   *  boolean and clear it when the POST resolved, but the first Realtime event
   *  for the new row lands some time AFTER that. In the gap `running` was still
   *  false, so the UI read the run as finished and the progress popup flipped
   *  straight to "Analysis complete" with every step unchecked, seconds into a
   *  1–2 minute pipeline. Seeding `pending` here (the same status the row is
   *  actually inserted with) closes it; Realtime then takes over normally. */
  markStarted: (runId: string) => void;
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

  // Guards the settle callback against duplicate or replayed events. Shared by
  // the Realtime handler and the backstop poll below so whichever sees a run
  // finish first is the only one that fires.
  const settledRunIds = useRef<Set<string>>(new Set());

  /** Fold one observed run row into state, from either source. */
  const applyRow = useCallback((row: {
    id?: string | null;
    status?: string | null;
    step_status?: Record<string, string> | null;
  }) => {
    if (!row?.status) return;
    setStatus(row.status);
    if (row.id) setRunId(row.id);
    if (row.step_status && typeof row.step_status === "object") setSteps(row.step_status);

    const terminal = row.status === RunStatus.COMPLETED || row.status === RunStatus.FAILED;
    if (!terminal) return;
    // Real status now governs — drop the optimistic hand-off so a
    // late-mounting instance can't re-adopt this finished run as if it had
    // just started.
    if (row.id && startedRuns.get(jobId) === row.id) startedRuns.delete(jobId);
    if (row.id && !settledRunIds.current.has(row.id)) {
      settledRunIds.current.add(row.id);
      settledRef.current?.();
    }
  }, [jobId]);

  useEffect(() => {
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
          applyRow(payload.new as Parameters<typeof applyRow>[0]);
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
  }, [jobId, applyRow]);

  // Backstop poll — armed ONLY while we believe a run is live, and it stops
  // itself the moment the row reports terminal.
  //
  // Realtime is the primary path, but events do get dropped. That used to be
  // invisible because the UI treated "not running" as "completed", so a missed
  // terminal event still landed on the right answer by accident. Now that
  // completion is only ever claimed when the row actually says so (which is
  // what stopped the popup lying seconds into a run), a dropped event would
  // instead strand the job on "Analysing…" forever — exactly the failure this
  // catches. Also covers the pipeline finishing while the tab was closed.
  useEffect(() => {
    if (!isActive(status)) return;
    let cancelled = false;

    async function check() {
      try {
        const res = await fetch(`/api/jobs/${jobId}/board-detail`);
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (!cancelled && data?.run) applyRow(data.run);
      } catch { /* transient — the next tick retries */ }
    }

    const id = setInterval(check, 8000);
    return () => { cancelled = true; clearInterval(id); };
  }, [jobId, status, applyRow]);

  // Adopt a run started by ANY instance for this job (including this one —
  // markStarted publishes rather than setting state directly, so both paths
  // go through here and stay identical).
  const adoptedRun = useRef<string | null>(null);
  useEffect(() => {
    const sync = () => {
      const startedId = startedRuns.get(jobId);
      if (!startedId || adoptedRun.current === startedId) return;
      adoptedRun.current = startedId;
      setRunId(startedId);
      setStatus(RunStatus.PENDING);
      // A re-analyse is a NEW row; the previous run's steps are not this one's.
      setSteps(null);
    };
    sync();
    startListeners.add(sync);
    return () => { startListeners.delete(sync); };
  }, [jobId]);

  const markStarted = useCallback((newRunId: string) => {
    publishStarted(jobId, newRunId);
  }, [jobId]);

  return { status, running: isActive(status), steps, runId, markStarted };
}

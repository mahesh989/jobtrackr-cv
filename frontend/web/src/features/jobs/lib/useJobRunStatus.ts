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
  clearStarting(jobId);            // the real run supersedes the optimistic flag
  startListeners.forEach((l) => l());
}

/**
 * Optimistic "starting" bridge — the click→POST gap.
 *
 * `startedRuns` above only fires once the enqueue POST returns a run id, so the
 * instance that did NOT do the click (e.g. the detail pane when Analyse was hit
 * on the board card) stayed idle for the whole POST round-trip before flipping.
 * Publishing the *intent* to start — before the POST — flips every mounted
 * instance for that job at once, so the card and the panel show "Analysing…"
 * on the same frame. Cleared when the real run is adopted (publishStarted) or
 * when the enqueue fails (markStartFailed).
 */
const startingJobs = new Set<string>();

function publishStarting(jobId: string) {
  startingJobs.add(jobId);
  startListeners.forEach((l) => l());
}

function clearStarting(jobId: string) {
  if (startingJobs.delete(jobId)) startListeners.forEach((l) => l());
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
  /** Optimistically flip THIS job to running across every mounted instance the
   *  instant a click lands, before the enqueue POST resolves. */
  markStarting: () => void;
  /** Roll back markStarting() when the enqueue fails to produce a run. */
  markStartFailed: () => void;
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
          // The letter is written in passes. The finished text (pass_3_final)
          // unlocks the fully-editable Cover letter tab — always refetch then.
          // No once-per-row guard: a regenerate legitimately completes twice.
          const row = payload.new as { pass_3_final?: string | null; status?: string | null } | null;
          if (!row) return;
          // Refetch whenever the outcome changes which tab shows: the finished
          // text landed (unlock the editable tab), the letter failed (drop the
          // tab), or the row first appeared — auto-generation STARTING, ~30-60s
          // before the text is ready, so the tab shows immediately in its
          // "Generating…" state rather than staying absent until it lands.
          // Intermediate pass updates are skipped as not worth a refetch.
          if (row.pass_3_final || row.status === "failed" || payload.eventType === "INSERT") {
            settledRef.current?.();
          }
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

  // Cover-letter settle backstop — armed once a run reaches COMPLETED, for the
  // same reason as the `cover_letters` Realtime subscription above: the
  // orchestrator marks the run completed before the detached auto-letter task
  // finishes, so the very first refetch after completion can land before the
  // letter exists, and if that one `cover_letters` Realtime message is then
  // also dropped, nothing left ever refetches — the Cover letter tab (and the
  // header's derived state) stays stuck until a manual reload. This polls
  // `board-detail` until the letter's outcome is known, then stops itself:
  // immediately if no letter was ever triggered (skipped/below-gate runs),
  // once it lands, or after a few minutes if it never does.
  useEffect(() => {
    if (status !== RunStatus.COMPLETED) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let revealedGenerating = false;   // fired the "letter is coming" refresh yet?
    const startedAt = Date.now();
    const MAX_MS = 5 * 60 * 1000;

    async function check() {
      if (cancelled) return;
      try {
        const res = await fetch(`/api/jobs/${jobId}/board-detail`);
        if (res.ok && !cancelled) {
          const data = await res.json();
          if (!cancelled) {
            const cls        = data?.run?.cover_letter_status ?? null;
            const letterDone = !!data?.cover_letter?.pass_3_final;
            if (cls !== "triggered") return; // nothing was ever coming — settled
            if (letterDone) { settledRef.current?.(); return; } // landed — one more refresh, then stop
            // Letter is generating. Fallback for a dropped cover_letters INSERT
            // Realtime event: reveal the "Generating…" tab once, then keep
            // polling for the finished text.
            if (!revealedGenerating) { revealedGenerating = true; settledRef.current?.(); }
          }
        }
      } catch { /* transient — retry on the next tick */ }
      if (!cancelled && Date.now() - startedAt < MAX_MS) {
        timer = setTimeout(check, 8000);
      }
    }

    timer = setTimeout(check, 8000);
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [jobId, status]);

  // Optimistic "a run is starting" flag for THIS job, mirrored across every
  // mounted instance (card + panel) via startingJobs so both flip on the same
  // frame the click happens — before the enqueue POST returns a run id.
  const [starting, setStarting] = useState<boolean>(startingJobs.has(jobId));

  // Adopt a run started by ANY instance for this job (including this one —
  // markStarted publishes rather than setting state directly, so both paths
  // go through here and stay identical). Same listener also mirrors the
  // optimistic `starting` flag.
  const adoptedRun = useRef<string | null>(null);
  useEffect(() => {
    const sync = () => {
      setStarting(startingJobs.has(jobId));
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

  // Once a real active status governs, the optimistic flag is redundant — drop
  // it so a stray uncleared `starting` can never outlive the run it stood in for.
  useEffect(() => {
    if (isActive(status)) clearStarting(jobId);
  }, [status, jobId]);

  /** Optimistic: flip every instance to "Analysing…" the instant the click
   *  lands, before the enqueue POST resolves. Pair with markStarted (on the
   *  returned run id) or markStartFailed (on error). */
  const markStarting = useCallback(() => {
    publishStarting(jobId);
  }, [jobId]);

  /** Roll back the optimistic flag when the enqueue never produced a run. */
  const markStartFailed = useCallback(() => {
    clearStarting(jobId);
  }, [jobId]);

  const markStarted = useCallback((newRunId: string) => {
    publishStarted(jobId, newRunId);
  }, [jobId]);

  // `running` folds in the optimistic flag so a single boolean drives every
  // "Analysing…" affordance identically, no matter which entry point fired.
  return { status, running: isActive(status) || starting, steps, runId, markStarting, markStartFailed, markStarted };
}

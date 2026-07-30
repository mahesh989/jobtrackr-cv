"use client";

import { useEffect, useRef, useState } from "react";
import type { BoardDetailPayload } from "./boardDetailTypes";

interface State {
  data:    BoardDetailPayload | null;
  loading: boolean;
  error:   string | null;
}

/**
 * Payloads already fetched this session, keyed by job id.
 *
 * Browsing a board means clicking back and forth between the same handful of
 * jobs, and every one of those clicks used to be a full round trip that blanked
 * the pane and showed a spinner for the best part of a second. The payload is
 * ~20KB of analysis JSON and only changes when a run or letter finishes — which
 * this pane already learns about over Realtime (see useJobRunStatus) and
 * responds to by bumping `reloadToken`. So a cache hit paints instantly and is
 * still revalidated in the background; a second visit to an unchanged job costs
 * nothing visible.
 *
 * Module-level, so it is per-tab and dies with the page — no invalidation
 * story needed beyond the revalidate below and the explicit reloadToken bump.
 */
const cache = new Map<string, BoardDetailPayload>();

/**
 * Lean per-job fetch for the board detail pane. Re-fetches whenever `jobId`
 * changes; a stale request whose job changed before it resolved is dropped
 * (guards against fast card-to-card clicking racing the response order).
 */
export function useBoardDetail(jobId: string | null, enabled: boolean = true, reloadToken: number = 0) {
  const seed = (id: string | null): State => {
    const hit = id ? cache.get(id) : undefined;
    // A cache hit is shown with loading:false so the pane renders real content
    // immediately instead of a spinner; the effect still revalidates behind it.
    return { data: hit ?? null, loading: !hit, error: null };
  };

  const [state, setState] = useState<State>(() => seed(jobId));
  // Monotonic per-request generation — NOT keyed by jobId. Guarding on jobId
  // alone (the old `activeId` ref) only caught the pane switching to a
  // DIFFERENT job; two overlapping fetches for the SAME job (e.g. the
  // thin-JD auto-analyse flow's back-to-back `refresh()` calls — one right
  // after the JD save, before any run exists, and another moments later once
  // the run starts) both passed that check, so whichever response resolved
  // LAST won even if it was fired FIRST. A stale empty payload landing after
  // the real one silently reverted the pane (and anything keyed off its
  // `data`, like the Cover letter tab's edit state) back to placeholder data.
  const requestSeq = useRef(0);

  // Swap to the new job's cached payload during render rather than in an
  // effect — same derive-state-during-render pattern useJobRunStatus uses for
  // its own re-seed. Doing it in an effect would paint one frame of the
  // previous job's data under the new job's header.
  const [seededFor, setSeededFor] = useState<string | null>(jobId);
  if (seededFor !== jobId) {
    setSeededFor(jobId);
    setState(seed(jobId));
  }

  useEffect(() => {
    // `enabled` is false for the off-screen twin of the detail pane (SmartFeed
    // mounts a desktop and a mobile copy; CSS hides one but both used to fetch).
    if (!enabled) return;
    if (!jobId) return; // nothing to fetch — the early return below covers this render
    const cached = cache.get(jobId);
    const mySeq = ++requestSeq.current;

    (async () => {
      try {
        const res = await fetch(`/api/jobs/${jobId}/board-detail`);
        if (mySeq !== requestSeq.current) return; // superseded by a newer request
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          // A failed revalidation shouldn't blow away a good cached payload.
          if (cached) return;
          setState({ data: null, loading: false, error: j.error ?? `Failed (${res.status})` });
          return;
        }
        const json = (await res.json()) as BoardDetailPayload;
        // Checked before the cache write too — an out-of-order response must
        // not clobber a fresher payload a later request already cached, or
        // the NEXT visit to this job would seed from the stale one.
        if (mySeq !== requestSeq.current) return;
        cache.set(jobId, json);
        setState({ data: json, loading: false, error: null });
      } catch (e) {
        if (mySeq !== requestSeq.current) return;
        if (cached) return;
        setState({ data: null, loading: false, error: e instanceof Error ? e.message : "Network error" });
      }
    })();
  }, [jobId, enabled, reloadToken]);

  if (!jobId) return { data: null, loading: false, error: null };
  // A disabled pane never fetches, so it is not loading — it is idle. Reporting
  // `loading: true` there was harmless while callers ignored the flag, but it
  // is a lie, and anything that renders a spinner from it (the Job description
  // tab now does) would spin forever on the twin that CSS hides.
  if (!enabled) return { data: state.data, loading: false, error: state.error };
  return state;
}

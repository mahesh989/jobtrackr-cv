"use client";

import { useEffect, useRef, useState } from "react";
import type { BoardDetailPayload } from "./boardDetailTypes";

interface State {
  data:    BoardDetailPayload | null;
  loading: boolean;
  error:   string | null;
}

/**
 * Lean per-job fetch for the board detail pane. Re-fetches whenever `jobId`
 * changes; a stale request whose job changed before it resolved is dropped
 * (guards against fast card-to-card clicking racing the response order).
 */
export function useBoardDetail(jobId: string | null, enabled: boolean = true, reloadToken: number = 0) {
  const [state, setState] = useState<State>({ data: null, loading: true, error: null });
  const activeId = useRef<string | null>(null);

  useEffect(() => {
    // `enabled` is false for the off-screen twin of the detail pane (SmartFeed
    // mounts a desktop and a mobile copy; CSS hides one but both used to fetch).
    if (!enabled) return;
    if (!jobId) return; // nothing to fetch — the early return below covers this render
    activeId.current = jobId;

    (async () => {
      setState({ data: null, loading: true, error: null });
      try {
        const res = await fetch(`/api/jobs/${jobId}/board-detail`);
        if (activeId.current !== jobId) return; // superseded by a newer selection
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          setState({ data: null, loading: false, error: j.error ?? `Failed (${res.status})` });
          return;
        }
        const json = (await res.json()) as BoardDetailPayload;
        if (activeId.current !== jobId) return;
        setState({ data: json, loading: false, error: null });
      } catch (e) {
        if (activeId.current !== jobId) return;
        setState({ data: null, loading: false, error: e instanceof Error ? e.message : "Network error" });
      }
    })();
  }, [jobId, enabled, reloadToken]);

  if (!jobId) return { data: null, loading: false, error: null };
  return state;
}

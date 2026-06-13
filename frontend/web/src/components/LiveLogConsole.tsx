"use client";

// Live tail of run_logs.log_lines for a single profile's currently-running run.
// Black terminal-style scrollback so the user can watch the pipeline tick
// through every adapter, every page, every dedup decision in near-real-time.
//
// Mounts under the LiveRunStatus banner. Hidden when no run is active.
// Open/closed state persists via a collapsible <details>.

import { useEffect, useRef, useState } from "react";

interface LogLine { t: string; msg: string }

interface RunsResponse {
  runs: { id: string; status: string }[];
}

interface LogsResponse {
  lines:  LogLine[];
  status: string;
}

const POLL_MS = 1500;

export function LiveLogConsole({ profileId }: { profileId: string }) {
  const [runId,   setRunId]   = useState<string | null>(null);
  const [lines,   setLines]   = useState<LogLine[]>([]);
  const [open,    setOpen]    = useState(false);
  const [active,  setActive]  = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // ── 1. Find the active running run for this profile ─────────────────────────
  useEffect(() => {
    let cancelled = false;
    async function findActive() {
      try {
        const res = await fetch(`/api/profiles/${profileId}/runs?status=running`, { cache: "no-store" });
        if (!res.ok) return;
        const { runs }: RunsResponse = await res.json();
        if (cancelled) return;
        const next = runs?.[0]?.id ?? null;
        setRunId((cur) => (cur === next ? cur : next));
        setActive(!!next);
      } catch { /* silent */ }
    }
    findActive();
    const id = setInterval(findActive, 4000);
    return () => { cancelled = true; clearInterval(id); };
  }, [profileId]);

  // ── 2. Poll log_lines while we have a runId ─────────────────────────────────
  useEffect(() => {
    if (!runId) {
      setLines([]);
      return;
    }
    let cancelled = false;
    async function poll() {
      try {
        const res = await fetch(`/api/profiles/${profileId}/runs/${runId}/logs`, { cache: "no-store" });
        if (!res.ok) return;
        const { lines: newLines, status }: LogsResponse = await res.json();
        if (cancelled) return;
        setLines(newLines);
        if (status !== "running") setActive(false);
      } catch { /* silent */ }
    }
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [profileId, runId]);

  // Auto-scroll to bottom when new lines arrive (only while open)
  useEffect(() => {
    if (open && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines, open]);

  if (!runId && lines.length === 0) return null;

  return (
    <details
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
      className="mb-4 rounded-md border border-border bg-surface anim-in"
    >
      <summary className="cursor-pointer select-none px-4 py-2.5 text-[12px] font-medium text-text-2 flex items-center gap-2 hover:bg-[var(--surface-2)] transition-colors rounded-md">
        <svg
          className={`w-3 h-3 transition-transform ${open ? "rotate-90" : ""}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7"/>
        </svg>
        <span>Pipeline console</span>
        <span className="text-text-3">·</span>
        <span className="text-text-3 font-mono text-[11px]">{lines.length} lines</span>
        {active && (
          <span className="ml-auto flex items-center gap-1.5 text-[var(--brand)] text-[11px]">
            <span className="relative flex h-1.5 w-1.5">
              <span className="dot-ping absolute inline-flex h-full w-full rounded-full bg-[var(--brand)] opacity-75"/>
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-[var(--brand)]"/>
            </span>
            live
          </span>
        )}
      </summary>

      <div
        ref={scrollRef}
        className="font-mono text-[11.5px] leading-[1.55] bg-[#0d1117] text-[#c9d1d9] px-4 py-3 max-h-72 overflow-y-auto border-t border-border rounded-b-md"
      >
        {lines.length === 0 ? (
          <div className="text-[#6e7681]">waiting for output…</div>
        ) : (
          lines.map((l, i) => (
            <div key={i} className="whitespace-pre-wrap break-all">
              <span className="text-[#6e7681]">{l.t.slice(11, 19)}</span>
              <span className="text-[#c9d1d9]"> {l.msg}</span>
            </div>
          ))
        )}
      </div>
    </details>
  );
}

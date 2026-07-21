"use client";

// Tail of run_logs.log_lines for a single profile's LATEST run.
// Black terminal-style scrollback so the user can watch the pipeline tick
// through every adapter, every page, every dedup decision in near-real-time —
// and, once the run finishes, the full log STAYS visible (frozen, no "live"
// dot) until the next run starts or the page is left. Open/closed state
// persists via a collapsible <details>.

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

  // ── 1. Track the LATEST run for this profile (running OR completed) ──────────
  // We no longer filter on status=running, so when a run finishes we keep the
  // same runId and its log stays on screen instead of vanishing.
  useEffect(() => {
    let cancelled = false;
    async function findLatest() {
      try {
        const res = await fetch(`/api/profiles/${profileId}/runs`, { cache: "no-store" });
        if (!res.ok) return;
        const { runs }: RunsResponse = await res.json();
        if (cancelled) return;
        const latest = runs?.[0] ?? null;       // route returns most-recent first
        const next = latest?.id ?? null;
        setRunId((cur) => (cur === next ? cur : next));
        setActive(latest?.status === "running");
      } catch { /* silent */ }
    }
    findLatest();
    const id = setInterval(findLatest, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, [profileId]);

  // ── 2. Poll log_lines for the current runId; stop polling once it ends but
  //       KEEP the lines on screen. ────────────────────────────────────────────
  useEffect(() => {
    if (!runId) return;       // no run history yet — don't wipe anything
    let cancelled = false;
    let id: ReturnType<typeof setInterval> | null = null;
    async function poll() {
      try {
        const res = await fetch(`/api/profiles/${profileId}/runs/${runId}/logs`, { cache: "no-store" });
        if (!res.ok) return;
        const { lines: newLines, status }: LogsResponse = await res.json();
        if (cancelled) return;
        setLines(newLines);
        if (status !== "running") {
          setActive(false);
          if (id) { clearInterval(id); id = null; }   // freeze: keep lines, stop polling
        }
      } catch { /* silent */ }
    }
    poll();
    id = setInterval(poll, POLL_MS);
    return () => { cancelled = true; if (id) clearInterval(id); };
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
      <summary className="cursor-pointer select-none px-4 py-2.5 text-label font-medium text-text-2 flex items-center gap-2 hover:bg-[var(--surface-2)] transition-colors rounded-md">
        <svg
          className={`w-3 h-3 transition-transform ${open ? "rotate-90" : ""}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7"/>
        </svg>
        <span>Pipeline console</span>
        <span className="text-text-3">·</span>
        <span className="text-text-3 font-mono text-caption">{lines.length} lines</span>
        {active && (
          <span className="ml-auto flex items-center gap-1.5 text-[var(--brand)] text-caption">
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

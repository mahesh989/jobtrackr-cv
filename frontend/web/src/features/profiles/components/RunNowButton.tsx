"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";

type State = "idle" | "running" | "stopping" | "error";

export function RunNowButton({
  profileId,
  compact = false,
  initialIsRunning = false,
}: {
  profileId: string;
  compact?: boolean;
  initialIsRunning?: boolean;
}) {
  const [state, setState] = useState<State>(initialIsRunning ? "running" : "idle");
  const router = useRouter();
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef<number | null>(null);

  // Poll while running or stopping to detect when the run ends
  useEffect(() => {
    if (state !== "running" && state !== "stopping") {
      if (pollRef.current) clearInterval(pollRef.current);
      return;
    }

    async function check() {
      // Grace period: don't conclude "not running" for 6s after clicking — worker needs time to pick up
      if (startedAtRef.current && Date.now() - startedAtRef.current < 6000) return;
      try {
        const res = await fetch(`/api/profiles/${profileId}/runs?status=running`);
        if (!res.ok) return;
        const { runs } = await res.json();
        const stillRunning = Array.isArray(runs) && runs.length > 0;
        if (!stillRunning) {
          setState("idle");
          startedAtRef.current = null;
          router.refresh();
        }
      } catch { /* silent */ }
    }

    pollRef.current = setInterval(check, 3000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [state, profileId, router]);

  async function handleRun(fullRefresh = false) {
    setState("running");
    startedAtRef.current = Date.now();
    const res = await fetch(`/api/profiles/${profileId}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fullRefresh }),
    });
    if (res.status === 402) {
      // Run cap / read-only — send the user to billing with the reason.
      const reason = await res.json().then((d) => d.reason as string | undefined).catch(() => undefined);
      router.push(`/billing?denied=${reason ?? "run_cap"}`);
      return;
    }
    if (!res.ok) setState("error");
  }

  async function handleStop() {
    setState("stopping");
    try {
      const res = await fetch(`/api/profiles/${profileId}/runs`, { method: "DELETE" });
      if (res.ok) {
        // DELETE flips run_logs.status to "failed" synchronously, so the UI
        // doesn't need to wait for the worker to notice the cancel at the next
        // stage boundary. Snap to idle now.
        setState("idle");
        startedAtRef.current = null;
        router.refresh();
      } else {
        setState("running"); // revert if request failed
      }
    } catch {
      setState("running"); // revert if request failed
    }
  }

  // ── Stop (running, can click to cancel) ──────────────────────────────────────
  if (state === "running") {
    return (
      <Button
        onClick={handleStop}
        title="Stop this run"
        variant="danger"
        className={`border-[var(--red)]/30 text-[var(--red)] bg-[var(--surface)] hover:bg-[var(--red-light)] transition-colors ${
          compact ? "px-2.5 py-1 text-label" : "text-body"
        }`}
      >
        <svg
          className={compact ? "w-3 h-3" : "w-3.5 h-3.5"}
          viewBox="0 0 24 24"
          fill="currentColor"
        >
          <rect x="4" y="4" width="16" height="16" rx="2" />
        </svg>
        {!compact && "Stop"}
      </Button>
    );
  }

  // ── Stopping (waiting for worker to ack) ─────────────────────────────────────
  if (state === "stopping") {
    return (
      <Button
        disabled
        className={`opacity-50 cursor-not-allowed ${
          compact ? "px-2.5 py-1 text-label" : "text-body"
        }`}
      >
        <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        {!compact && "Stopping…"}
      </Button>
    );
  }

  // ── Error ─────────────────────────────────────────────────────────────────────
  if (state === "error") {
    return (
      <Button
        onClick={() => handleRun(false)}
        variant="danger"
        className={`text-[var(--red)] border-[var(--red)]/30 bg-[var(--red-light)] ${
          compact ? "px-2.5 py-1 text-label" : "text-body"
        }`}
      >
        Retry
      </Button>
    );
  }

  // ── Idle (play button) ────────────────────────────────────────────────────────
  const runBtn = (
    <Button
      onClick={() => handleRun(false)}
      title="Run now — fetch jobs posted since the last run (incremental)"
      className={compact ? "px-2.5 py-1 text-label" : "text-body"}
    >
      <svg
        className={compact ? "w-3 h-3" : "w-3.5 h-3.5"}
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth="2.5"
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M5 3l14 9-14 9V3z" />
      </svg>
      {!compact && "Run now"}
    </Button>
  );

  if (compact) return runBtn;

  // Non-compact (profile page): also offer a deep "Full refresh" that re-scans
  // the whole 28-day window instead of just what's new since the last run.
  return (
    <div className="flex items-center gap-2">
      {runBtn}
      <Button
        onClick={() => handleRun(true)}
        title="Full refresh — re-scan the past 28 days (ignores incremental window). Slower; use when you want the whole backlog again."
        className="text-text-2"
      >
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
        Full refresh
      </Button>
    </div>
  );
}

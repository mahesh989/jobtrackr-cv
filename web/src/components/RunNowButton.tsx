"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

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

  async function handleRun() {
    setState("running");
    startedAtRef.current = Date.now();
    const res = await fetch(`/api/profiles/${profileId}/run`, { method: "POST" });
    if (!res.ok) setState("error");
  }

  async function handleStop() {
    setState("stopping");
    try {
      await fetch(`/api/profiles/${profileId}/runs`, { method: "DELETE" });
    } catch {
      setState("running"); // revert if request failed
    }
  }

  // ── Stop (running, can click to cancel) ──────────────────────────────────────
  if (state === "running") {
    return (
      <button
        onClick={handleStop}
        title="Stop this run"
        className={`gh-btn border-[#CF222E]/30 text-[#CF222E] bg-white hover:bg-[#FFEBE9] transition-colors ${
          compact ? "px-2.5 py-1 text-[12px]" : "text-[13px]"
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
      </button>
    );
  }

  // ── Stopping (waiting for worker to ack) ─────────────────────────────────────
  if (state === "stopping") {
    return (
      <button
        disabled
        className={`gh-btn opacity-50 cursor-not-allowed ${
          compact ? "px-2.5 py-1 text-[12px]" : "text-[13px]"
        }`}
      >
        <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        {!compact && "Stopping…"}
      </button>
    );
  }

  // ── Error ─────────────────────────────────────────────────────────────────────
  if (state === "error") {
    return (
      <button
        onClick={handleRun}
        className={`gh-btn text-[#CF222E] border-[#CF222E]/30 bg-[#FFEBE9] ${
          compact ? "px-2.5 py-1 text-[12px]" : "text-[13px]"
        }`}
      >
        Retry
      </button>
    );
  }

  // ── Idle (play button) ────────────────────────────────────────────────────────
  return (
    <button
      onClick={handleRun}
      title="Run pipeline now"
      className={`gh-btn ${compact ? "px-2.5 py-1 text-[12px]" : "text-[13px]"}`}
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
    </button>
  );
}

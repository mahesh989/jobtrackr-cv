"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type BannerState = "running" | "stopping" | "stopped" | "hidden";

interface ActiveRun {
  current_stage: string | null;
  started_at:    string;
}

export function LiveRunStatus({
  profileId,
  initialIsRunning = false,
}: {
  profileId: string;
  initialIsRunning?: boolean;
}) {
  // Seed banner state from server-side knowledge so the banner appears the
  // instant the page renders during an active run — no 3-12s polling wait.
  const [banner,  setBanner]   = useState<BannerState>(initialIsRunning ? "running" : "hidden");
  const [run,     setRun]      = useState<ActiveRun | null>(null);
  const [elapsed, setElapsed]  = useState(0);
  const [stopping, setStopping] = useState(false);
  const wasRunning             = useRef(false);
  const router                 = useRouter();

  // ── Poll for running state ────────────────────────────────────────────────────
  useEffect(() => {
    let tick: ReturnType<typeof setInterval>;

    async function check() {
      try {
        const res = await fetch(`/api/profiles/${profileId}/runs?status=running`);
        if (!res.ok) return;
        const { runs } = await res.json();
        const active = Array.isArray(runs) && runs.length > 0 ? runs[0] as ActiveRun : null;
        const running = !!active;

        if (running && banner === "hidden") {
          setBanner("running");
          setStopping(false);
        }
        setRun(active);

        if (wasRunning.current && !running) {
          // Transition: running → stopped (brief tick) → hidden
          setStopping(false);
          setBanner("stopped");
          router.refresh();
          setTimeout(() => setBanner("hidden"), 2000);
        }

        wasRunning.current = running;
        if (!running && banner !== "stopped") setBanner((b) => b === "hidden" ? "hidden" : b);
      } catch { /* silent */ }
    }

    const isActive = banner === "running" || banner === "stopping";
    check();
    const poll = setInterval(check, isActive ? 3000 : 12000);

    if (banner === "running") {
      tick = setInterval(() => {
        if (run?.started_at) {
          setElapsed(Math.max(0, Math.floor((Date.now() - new Date(run.started_at).getTime()) / 1000)));
        }
      }, 1000);
    } else {
      // Part of this same polling-interval-setup effect (setInterval above,
      // async check() polling) — the setState here is a branch of that
      // machinery, not a standalone sync-on-change case.
      // eslint-disable-next-line react-hooks/set-state-in-effect -- branch of a real polling-interval effect
      setElapsed(0);
    }

    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [profileId, banner, router, run?.started_at]);

  async function handleStop() {
    setStopping(true);
    setBanner("stopping");
    try {
      const res = await fetch(`/api/profiles/${profileId}/runs`, { method: "DELETE" });
      if (res.ok) {
        // Row is already flipped to "failed". Don't wait for the next poll cycle.
        setStopping(false);
        setBanner("stopped");
        router.refresh();
        setTimeout(() => setBanner("hidden"), 2000);
      } else {
        setStopping(false);
        setBanner("running");
      }
    } catch {
      setStopping(false);
      setBanner("running");
    }
  }

  if (banner === "hidden") return null;

  // ── Stopped state — brief confirmation before banner disappears ───────────────
  if (banner === "stopped") {
    return (
      <div className="mb-4 anim-in">
        <div className="border border-[var(--green)]/20 bg-[var(--green-light)]/60 rounded-md px-4 py-3 flex items-center gap-3">
          <svg className="w-4 h-4 text-[var(--green)] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"/>
          </svg>
          <p className="text-[13px] font-semibold text-[var(--green)]">Pipeline complete — feed updated</p>
        </div>
      </div>
    );
  }

  // ── Running / Stopping state ──────────────────────────────────────────────────
  return (
    <div className="mb-4 anim-in">
      {/* Animated gradient bar — freezes grey while stopping */}
      <div className={`h-0.5 rounded-t-md ${stopping ? "bg-[var(--border)]" : "pipeline-bar"}`} />

      <div className="border border-t-0 border-[var(--brand)]/20 bg-[var(--blue-light)]/60 rounded-b-md px-4 py-3 flex items-center justify-between gap-4">
        {/* Left: status text */}
        <div className="flex items-center gap-3">
          <span className="relative flex h-2.5 w-2.5 shrink-0">
            <span className={`absolute inline-flex h-full w-full rounded-full bg-[var(--brand)] opacity-75 ${stopping ? "" : "dot-ping"}`} />
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-[var(--brand)]" />
          </span>
          <div>
            <p className="text-[13px] font-semibold text-[var(--brand)]">
              {stopping ? "Stopping…" : "Pipeline running"}
            </p>
            <p className="text-[11px] text-text-2 mt-0.5">
              {stopping
                ? "Finishing current stage, then stopping"
                : `${run?.current_stage ?? "Starting"}${elapsed > 0 ? ` · ${elapsed}s` : "…"}`}
            </p>
          </div>
        </div>

        {/* Right: stop button */}
        <div className="flex items-center gap-3">
          <button onClick={handleStop} disabled={stopping} title="Stop this run" className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[12px] font-medium border border-[#CF222E]/30 text-[#CF222E] bg-white hover:bg-[#FFEBE9] transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
            {stopping ? (
              <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
              </svg>
            ) : (
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor">
                <rect x="4" y="4" width="16" height="16" rx="2"/>
              </svg>
            )}
            {stopping ? "Stopping" : "Stop"}
          </button>
        </div>
      </div>
    </div>
  );
}

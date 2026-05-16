"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

const STAGES = [
  { key: "fetch",  label: "Fetching from 21+ sources" },
  { key: "dedup",  label: "Deduplicating results" },
  { key: "score",  label: "AI scoring with Claude Haiku" },
  { key: "save",   label: "Saving to your feed" },
];

type BannerState = "running" | "stopping" | "stopped" | "hidden";

export function LiveRunStatus({ profileId }: { profileId: string }) {
  const [banner, setBanner]         = useState<BannerState>("hidden");
  const [stageIdx, setStageIdx]     = useState(0);
  const [stopping, setStopping]     = useState(false);
  const wasRunning                  = useRef(false);
  const router                      = useRouter();

  // ── Poll for running state ────────────────────────────────────────────────────
  useEffect(() => {
    let poll: ReturnType<typeof setInterval>;
    let stage: ReturnType<typeof setInterval>;

    async function check() {
      try {
        const res = await fetch(`/api/profiles/${profileId}/runs?status=running`);
        if (!res.ok) return;
        const { runs } = await res.json();
        const running = Array.isArray(runs) && runs.length > 0;

        if (running && banner === "hidden") {
          setBanner("running");
          setStopping(false);
        }

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
    poll = setInterval(check, isActive ? 3000 : 12000);

    if (banner === "running") {
      stage = setInterval(() => setStageIdx((i) => (i + 1) % STAGES.length), 3500);
    }

    return () => {
      clearInterval(poll);
      clearInterval(stage);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, banner, router]);

  async function handleStop() {
    setStopping(true);
    setBanner("stopping");
    try {
      await fetch(`/api/profiles/${profileId}/runs`, { method: "DELETE" });
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
        <div className="border border-[#1A7F37]/20 bg-[#DAFBE1]/60 rounded-md px-4 py-3 flex items-center gap-3">
          <svg className="w-4 h-4 text-[#1A7F37] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"/>
          </svg>
          <p className="text-[13px] font-semibold text-[#1A7F37]">Pipeline complete — feed updated</p>
        </div>
      </div>
    );
  }

  // ── Running / Stopping state ──────────────────────────────────────────────────
  return (
    <div className="mb-4 anim-in">
      {/* Animated gradient bar — freezes grey while stopping */}
      <div className={`h-0.5 rounded-t-md ${stopping ? "bg-[var(--border)]" : "pipeline-bar"}`} />

      <div className="border border-t-0 border-[var(--brand)]/20 bg-[#DDF4FF]/60 rounded-b-md px-4 py-3 flex items-center justify-between gap-4">
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
                : `${STAGES[stageIdx].label}…`}
            </p>
          </div>
        </div>

        {/* Right: stage pills + stop button */}
        <div className="flex items-center gap-3">
          {!stopping && (
            <div className="hidden sm:flex items-center gap-1.5">
              {STAGES.map((s, i) => (
                <div
                  key={s.key}
                  className={`h-1.5 rounded-full transition-all duration-500 ${
                    i === stageIdx
                      ? "w-6 bg-[var(--brand)]"
                      : i < stageIdx
                      ? "w-3 bg-[var(--brand)]/40"
                      : "w-3 bg-[var(--border)]"
                  }`}
                />
              ))}
            </div>
          )}

          <button
            onClick={handleStop}
            disabled={stopping}
            title="Stop this run"
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[12px] font-medium border border-[#CF222E]/30 text-[#CF222E] bg-white hover:bg-[#FFEBE9] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
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

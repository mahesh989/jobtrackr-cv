"use client";

/**
 * Pipeline Funnel — replaces StatusTabs + ProgressChips + TriageBanner.
 *
 * A horizontal connected bar showing jobs flowing through pipeline stages:
 *   Discovered → Analysed → CV Ready → Letter Ready → Applied
 *
 * Click a stage to filter. Triage sub-signals appear below the active stage.
 * "Dismissed" is a separate subtle toggle outside the funnel.
 *
 * URL params:
 *   ?stage=analysed|cvReady|letterReady|applied|dismissed  (default: all)
 *   ?triage=needsJd|roleMismatch|belowThreshold|hasEmail   (sub-filter)
 */

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useTransition } from "react";
import { Archive } from "lucide-react";

export interface FunnelCounts {
  discovered: number;
  analysed: number;
  cvReady: number;
  letterReady: number;
  applied: number;
  dismissed: number;
  newCount: number;
  needsJd: number;
  roleMismatch: number;
  belowThreshold: number;
  hasEmail: number;
}

interface TriageItem {
  key: string;
  label: string;
  countKey: keyof FunnelCounts;
}

interface StageConfig {
  key: string;
  label: string;
  countKey: keyof FunnelCounts;
  triage?: TriageItem[];
}

const STAGES: StageConfig[] = [
  {
    key: "all",
    label: "Discovered",
    countKey: "discovered",
    triage: [
      { key: "needsJd", label: "need JD", countKey: "needsJd" },
      { key: "roleMismatch", label: "role mismatch", countKey: "roleMismatch" },
    ],
  },
  {
    key: "analysed",
    label: "Analysed",
    countKey: "analysed",
    triage: [
      { key: "belowThreshold", label: "below ATS", countKey: "belowThreshold" },
    ],
  },
  { key: "cvReady", label: "CV Ready", countKey: "cvReady" },
  {
    key: "letterReady",
    label: "Letter Ready",
    countKey: "letterReady",
    triage: [
      { key: "hasEmail", label: "have email", countKey: "hasEmail" },
    ],
  },
  { key: "applied", label: "Applied", countKey: "applied" },
];

/* Stage accent colors — blend with surface for theme compat */
const STAGE_ACCENTS = [
  "color-mix(in srgb, #6366f1 18%, var(--surface))",  // indigo
  "color-mix(in srgb, #3b82f6 18%, var(--surface))",  // blue
  "color-mix(in srgb, #06b6d4 18%, var(--surface))",  // cyan
  "color-mix(in srgb, #10b981 18%, var(--surface))",  // emerald
  "color-mix(in srgb, #22c55e 18%, var(--surface))",  // green
];

const STAGE_DOTS = ["#6366f1", "#3b82f6", "#06b6d4", "#10b981", "#22c55e"];

export function PipelineFunnel({ counts }: { counts: FunnelCounts }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [, startTransition] = useTransition();

  const currentStage = sp.get("stage") || "all";
  const currentTriage = sp.get("triage") || "";

  function selectStage(stageKey: string) {
    const params = new URLSearchParams(sp.toString());
    if (stageKey === "all") {
      params.delete("stage");
    } else {
      params.set("stage", stageKey);
    }
    params.delete("triage");
    params.delete("status");
    params.delete("chips");
    startTransition(() => router.replace(`${pathname}?${params}`));
  }

  function selectTriage(triageKey: string) {
    const params = new URLSearchParams(sp.toString());
    if (currentTriage === triageKey) {
      params.delete("triage");
    } else {
      params.set("triage", triageKey);
    }
    startTransition(() => router.replace(`${pathname}?${params}`));
  }

  function toggleDismissed() {
    const params = new URLSearchParams(sp.toString());
    if (currentStage === "dismissed") {
      params.delete("stage");
    } else {
      params.set("stage", "dismissed");
      params.delete("triage");
    }
    startTransition(() => router.replace(`${pathname}?${params}`));
  }

  /* Active stage's triage sub-labels */
  const activeStage = STAGES.find((s) => s.key === currentStage);
  const visibleTriage = (activeStage?.triage ?? []).filter(
    (t) => counts[t.countKey] > 0
  );

  return (
    <div className="space-y-2">
      {/* ── Main funnel bar ──────────────────────────────── */}
      <div className="flex items-stretch gap-px rounded-lg overflow-hidden border border-[var(--border)]">
        {STAGES.map((stage, i) => {
          const count = counts[stage.countKey];
          const isActive = currentStage === stage.key;
          return (
            <button
              key={stage.key}
              onClick={() => selectStage(stage.key)}
              className="flex-1 flex flex-col items-center justify-center py-2.5 px-2 transition-all duration-200 relative cursor-pointer min-w-0"
              style={{
                background: isActive
                  ? `linear-gradient(135deg, ${STAGE_DOTS[i]}22, ${STAGE_DOTS[i]}11)`
                  : STAGE_ACCENTS[i],
                borderBottom: isActive ? `2px solid ${STAGE_DOTS[i]}` : "2px solid transparent",
              }}
              title={`Show ${count} ${stage.label.toLowerCase()} jobs`}
            >
              {/* Stage dot */}
              <span
                className="w-1.5 h-1.5 rounded-full mb-1 shrink-0"
                style={{ background: STAGE_DOTS[i], opacity: isActive ? 1 : 0.4 }}
              />
              <span
                className="text-base font-bold leading-none"
                style={{ color: isActive ? STAGE_DOTS[i] : "var(--text)" }}
              >
                {count}
              </span>
              <span
                className={`text-[9px] font-semibold uppercase tracking-wider mt-0.5 truncate max-w-full ${
                  isActive ? "opacity-90" : "opacity-50"
                }`}
                style={{ color: isActive ? STAGE_DOTS[i] : "var(--text-2)" }}
              >
                {stage.label}
              </span>

              {/* New badge pulse on Discovered */}
              {stage.key === "all" && counts.newCount > 0 && (
                <span
                  className="absolute top-1.5 right-1.5 flex items-center justify-center"
                  title={`${counts.newCount} new`}
                >
                  <span className="w-2 h-2 rounded-full bg-[var(--brand)] animate-pulse" />
                </span>
              )}

              {/* Chevron separator (all except last) */}
              {i < STAGES.length - 1 && (
                <span
                  className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-1/2 z-10 text-[var(--border)] text-[10px] select-none"
                  aria-hidden
                >
                  ›
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* ── Triage sub-labels + dismissed toggle ─────────── */}
      <div className="flex items-center gap-3 min-h-[20px]">
        {/* Triage sub-labels for active stage */}
        {visibleTriage.length > 0 && (
          <div className="flex items-center gap-2">
            {visibleTriage.map((t) => {
              const count = counts[t.countKey];
              const isTriageActive = currentTriage === t.key;
              return (
                <button
                  key={t.key}
                  onClick={() => selectTriage(t.key)}
                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium transition-all border ${
                    isTriageActive
                      ? "bg-amber-50 border-amber-200 text-amber-800"
                      : "bg-transparent border-transparent text-text-3 hover:text-text-2 hover:border-[var(--border)]"
                  }`}
                >
                  <span className="font-bold">{count}</span>
                  <span>{t.label}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Dismissed toggle */}
        {counts.dismissed > 0 && (
          <button
            onClick={toggleDismissed}
            className={`inline-flex items-center gap-1 text-[11px] transition-colors ${
              currentStage === "dismissed"
                ? "text-text-2 font-medium"
                : "text-text-3 hover:text-text-2"
            }`}
          >
            <Archive className="w-3 h-3" />
            {counts.dismissed} dismissed
          </button>
        )}
      </div>
    </div>
  );
}

"use client";

/**
 * SmartToolbar — unified filter + sort bar that replaces PipelineFunnel +
 * SmartFilterBar on both the dashboard and the per-profile job board.
 *
 * Layout (matches /dashboard/beta/job-feed):
 *   Row 1: lens-prefixed location/company search · sort dropdown
 *          (· "Within X km" distance select when homeAddress is set)
 *   Row 2: "STAGE" label · 7 chips with live counts
 *          Thin JD · Full JD · Analysed · CV ready · Letter ready · Applied · Archived
 *   Row 3: "ATS" label · 4 chips with counts, colour-coded per band
 *          ≥ 70 · 60–69 · < 60 · Not analysed
 *
 * Single-select per row — click an active chip to clear it. URL params:
 *   stage / triage / ats   — view filters, shallow nav (instant, no refetch)
 *   sort / dir / min_keywords / max_distance — also shallow
 *   location / posted_within / source — dataset narrowers, real router replace
 */

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useTransition } from "react";
import { X } from "lucide-react";
import type { FunnelCounts } from "./PipelineFunnel";
import type { AtsBand } from "./jobFilters";
import { shallowSetParams } from "./shallowNav";
import { type AtsThresholds } from "@/lib/atsThresholds";

// Sort options — mirror the legacy SmartFilterBar so URLs stay compatible.
// `match` is new (a beta carry-over) and falls back to posted_at server-side
// since jobFilters.sortJobs doesn't know it — the SmartFeed re-sorts client-side.
const SORT_OPTIONS = [
  { value: "match",               label: "Match score" },
  { value: "posted_at",           label: "Date posted" },
  { value: "created_at",          label: "Date added" },
  { value: "rich_jd_first",       label: "Rich JD first" },
  { value: "recently_progressed", label: "Recently progressed" },
  { value: "most_progressed",     label: "Most progressed" },
  { value: "distance",            label: "Distance (nearest)" },
] as const;

// "over50" is a sentinel — it filters to jobs *farther* than 50 km by setting
// min_distance=50 and clearing max_distance, rather than the usual within-X cap.
const DISTANCE_OPTIONS = [
  { value: "",       label: "Any distance" },
  { value: "5",      label: "Within 5 km" },
  { value: "10",     label: "Within 10 km" },
  { value: "25",     label: "Within 25 km" },
  { value: "50",     label: "Within 50 km" },
  { value: "over50", label: "Over 50 km" },
] as const;

// Stage chips — combination of stage + triage URL params so we can render the
// canonical 7-chip set from a single row. `kind` decides which param this
// chip writes to; selecting one always clears the other so they stay
// mutually exclusive.
interface StageChip {
  id: string;            // chip id (used for active comparison)
  label: string;
  kind: "stage" | "triage";
  value: string;         // URL value to set
  countKey: keyof FunnelCounts;
}

const JOBS_CHIPS: StageChip[] = [
  { id: "favourite", label: "Favourite", kind: "stage", value: "favourite", countKey: "favourite" as keyof FunnelCounts },
  { id: "dismissed", label: "Archive",   kind: "stage", value: "dismissed", countKey: "dismissed" as keyof FunnelCounts },
];

const ANALYSIS_CHIPS: StageChip[] = [
  { id: "analysed",  label: "Analysed",  kind: "stage", value: "analysed", countKey: "analysed" as keyof FunnelCounts },
];

const STAGE_CHIPS_NEW: StageChip[] = [
  { id: "thinJd",      label: "Thin JD",      kind: "stage",  value: "thinJd",      countKey: "thinJd"      },
  { id: "richJd",      label: "Full JD",      kind: "triage", value: "richJd",      countKey: "richJd"      },
  { id: "cvReady",     label: "CV ready",     kind: "stage",  value: "cvReady",     countKey: "cvReady"     },
  { id: "letterReady", label: "Letter ready", kind: "stage",  value: "letterReady", countKey: "letterReady" },
  { id: "applied",     label: "Applied",      kind: "stage",  value: "applied",     countKey: "applied"     },
];

// View-filter URL keys → committed via the History API for instant feedback.

// View-filter URL keys → committed via the History API for instant feedback.
// Dataset narrowers (location / posted_within / source) hit the real router.
const SHALLOW_KEYS = new Set(["stage", "triage", "ats", "sort", "dir", "min_keywords", "max_distance", "min_distance"]);

export function SmartToolbar({
  counts,
  atsCounts,
  homeAddress = null,
  thresholds = { initial: 60, final: 70 },
}: {
  counts:       FunnelCounts;
  atsCounts:    Record<AtsBand, number>;
  /** When set (per-profile board with home_address), the "Within X km"
   *  distance select renders. */
  homeAddress?: string | null;
  thresholds?:  AtsThresholds;
}) {
  const router   = useRouter();
  const pathname = usePathname();
  const sp       = useSearchParams();
  const [pending, startTransition] = useTransition();

  const currentStage    = sp.get("stage")        || "";
  const currentTriage   = sp.get("triage")       || "";
  const currentAts      = sp.get("ats")          || "";
  const currentSort     = sp.get("sort")         || "posted_at";
  const currentLocation = sp.get("location")     || "";
  const currentMaxDistance = sp.get("max_distance") || "";
  const currentMinDistance = sp.get("min_distance") || "";
  // What the Distance dropdown shows: "over50" when a lower bound ≥50 is set
  // with no upper cap, otherwise the within-X value (or "" for Any).
  const distanceValue =
    !currentMaxDistance && Number(currentMinDistance) >= 50 ? "over50" : currentMaxDistance;

  function commit(params: URLSearchParams, key: string) {
    if (SHALLOW_KEYS.has(key)) shallowSetParams(pathname, params);
    else startTransition(() => router.replace(`${pathname}?${params}`, { scroll: false }));
  }

  function setOne(key: string, value: string) {
    const next = new URLSearchParams(Array.from(sp.entries()));
    if (value) next.set(key, value); else next.delete(key);
    commit(next, key);
  }

  /** Distance dropdown — maps the within-X / over-50 choices onto the
   *  min_distance + max_distance URL pair (shared with the ribbon slider). */
  function setDistance(value: string) {
    const next = new URLSearchParams(Array.from(sp.entries()));
    if (value === "over50") {
      next.set("min_distance", "50");
      next.delete("max_distance");
    } else if (value) {
      next.set("max_distance", value);
      next.delete("min_distance");
    } else {
      next.delete("max_distance");
      next.delete("min_distance");
    }
    commit(next, "max_distance");
  }

  function selectStageChip(chip: StageChip) {
    const next = new URLSearchParams(Array.from(sp.entries()));
    const isActive = chip.kind === "stage"
      ? currentStage === chip.value
      : currentTriage === chip.value;
    if (isActive) {
      // toggle off
      next.delete(chip.kind);
    } else {
      next.set(chip.kind, chip.value);
      // mutually exclusive — clear the other side
      next.delete(chip.kind === "stage" ? "triage" : "stage");
    }
    commit(next, chip.kind);
  }

  /** "All jobs" reset — clears both stage and triage so the feed falls back
   *  to the smart-section default view. */
  function clearStageAndTriage() {
    const next = new URLSearchParams(Array.from(sp.entries()));
    next.delete("stage");
    next.delete("triage");
    commit(next, "stage");
  }

  const allJobsActive = !currentStage && !currentTriage;

  function selectAtsChip(band: AtsBand) {
    const next = new URLSearchParams(Array.from(sp.entries()));
    if (currentAts === band) next.delete("ats");
    else next.set("ats", band);
    commit(next, "ats");
  }

  function isStageActive(chip: StageChip): boolean {
    return chip.kind === "stage"
      ? currentStage === chip.value
      : currentTriage === chip.value;
  }

  const atsBands: { id: AtsBand; label: string; tip: string; dot: string; chipBg: string; chipText: string }[] = [
    { id: "above_final",   label: `ATS ≥ ${thresholds.final}`,     tip: `Above the final gate (${thresholds.final}) — auto cover letter eligible`, dot: "bg-green-500", chipBg: "bg-green-100",          chipText: "text-green-800" },
    { id: "below_final",   label: `ATS ${thresholds.initial}–${thresholds.final - 1}`,    tip: `Between gates — tailored CV, no auto cover letter`,      dot: "bg-amber-500", chipBg: "bg-amber-100",          chipText: "text-amber-800" },
    { id: "below_initial", label: `ATS < ${thresholds.initial}`,     tip: `Below the initial gate (${thresholds.initial}) — pipeline stopped`,         dot: "bg-red-500",   chipBg: "bg-red-100",            chipText: "text-red-800"   },
    { id: "no_ats",        label: "Not analysed", tip: "No ATS score yet — click Analyze on the card",           dot: "bg-gray-300",  chipBg: "bg-[var(--surface-2)]", chipText: "text-text-2"    },
  ];

  return (
    <div className="rounded-md border border-border bg-surface p-3 space-y-3">
      {/* Row 1 — location search, sort, optional distance */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px]">
          <input
            type="text"
            defaultValue={currentLocation}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v !== currentLocation) setOne("location", v);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
            placeholder="Filter by location or company…"
            className="field pl-3 pr-8 text-[12px]"
          />
          {currentLocation && (
            <button
              onClick={() => setOne("location", "")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-text-3 hover:text-text"
              aria-label="Clear location filter"
              disabled={pending}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        <label className="flex items-center gap-1.5 text-[11px] text-text-2 shrink-0">
          Sort
          <select
            value={currentSort}
            onChange={(e) => setOne("sort", e.target.value)}
            className="field text-[12px] py-1 pr-7"
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
      </div>

      {/* Distance row — right-aligned to line up with Sort above it. */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <label className="flex items-center gap-1.5 text-[11px] text-text-2 shrink-0">
          Distance
          <select
            value={distanceValue}
            onChange={(e) => setDistance(e.target.value)}
            className="field text-[12px] py-1 pr-7"
            title={homeAddress ? `Distance from ${homeAddress}` : "Distance from each profile's home address"}
          >
            {DISTANCE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
      </div>

      {/* Row 2 — Jobs: All jobs, Favourite, Archive */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] uppercase font-semibold text-text-3 tracking-wider mr-1 w-12 shrink-0">Jobs</span>

        <button
          type="button"
          onClick={clearStageAndTriage}
          title="Clear stage filter — show everything"
          className={`inline-flex items-center gap-1.5 text-[11px] px-2 py-0.5 rounded-full border transition-colors ${
            allJobsActive
              ? "bg-[var(--brand)] text-white border-[var(--brand)] font-medium"
              : "bg-surface text-text-2 border-border hover:bg-[var(--surface-2)]"
          }`}
        >
          All jobs
          <span className={`tabular-nums ${allJobsActive ? "text-white/80" : "text-text-3"}`}>
            {counts.discovered}
          </span>
        </button>

        {JOBS_CHIPS.map((chip) => {
          const active = isStageActive(chip);
          const count  = counts[chip.countKey] ?? 0;
          return (
            <button
              key={chip.id}
              type="button"
              onClick={() => selectStageChip(chip)}
              disabled={count === 0 && !active}
              className={`inline-flex items-center gap-1.5 text-[11px] px-2 py-0.5 rounded-full border transition-colors ${
                active
                  ? "bg-[var(--brand)] text-white border-[var(--brand)] font-medium"
                  : count === 0
                    ? "bg-surface text-text-3 border-border opacity-50 cursor-not-allowed"
                    : "bg-surface text-text-2 border-border hover:bg-[var(--surface-2)]"
              }`}
            >
              {chip.label}
              {count > 0 && (
                <span className={`tabular-nums ${active ? "text-white/80" : "text-text-3"}`}>{count}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Row 3 — Analysis: Analysed, Not analysed */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] uppercase font-semibold text-text-3 tracking-wider mr-1 w-12 shrink-0">Analysis</span>
        {ANALYSIS_CHIPS.map((chip) => {
          const active = isStageActive(chip);
          const count  = counts[chip.countKey] ?? 0;
          return (
            <button
              key={chip.id}
              type="button"
              onClick={() => selectStageChip(chip)}
              disabled={count === 0 && !active}
              className={`inline-flex items-center gap-1.5 text-[11px] px-2 py-0.5 rounded-full border transition-colors ${
                active
                  ? "bg-[var(--brand)] text-white border-[var(--brand)] font-medium"
                  : count === 0
                    ? "bg-surface text-text-3 border-border opacity-50 cursor-not-allowed"
                    : "bg-surface text-text-2 border-border hover:bg-[var(--surface-2)]"
              }`}
            >
              {chip.label}
              {count > 0 && (
                <span className={`tabular-nums ${active ? "text-white/80" : "text-text-3"}`}>{count}</span>
              )}
            </button>
          );
        })}
        {/* Render "Not analysed" from atsBands here instead of ATS row */}
        {(() => {
          const notAnalysedBand = atsBands.find(b => b.id === "no_ats");
          if (!notAnalysedBand) return null;
          const active = currentAts === "no_ats";
          const count  = atsCounts["no_ats"] ?? 0;
          return (
            <button
              key="not_analysed"
              type="button"
              onClick={() => selectAtsChip("no_ats")}
              title={notAnalysedBand.tip}
              disabled={count === 0 && !active}
              className={`inline-flex items-center gap-1.5 text-[11px] px-2 py-0.5 rounded-full border transition-colors ${
                active
                  ? `${notAnalysedBand.chipBg} ${notAnalysedBand.chipText} border-current font-medium`
                  : count === 0
                    ? "bg-surface text-text-3 border-border opacity-50 cursor-not-allowed"
                    : "bg-surface text-text-2 border-border hover:bg-[var(--surface-2)]"
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${notAnalysedBand.dot}`} />
              {notAnalysedBand.label}
              {count > 0 && (
                <span className={`tabular-nums ${active ? "" : "text-text-3"}`}>{count}</span>
              )}
            </button>
          );
        })()}
      </div>

      {/* Row 4 — Stage: Thin JD, Full JD, CV ready, Letter ready, Applied */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] uppercase font-semibold text-text-3 tracking-wider mr-1 w-12 shrink-0">Stage</span>
        {STAGE_CHIPS_NEW.map((chip) => {
          const active = isStageActive(chip);
          const count  = counts[chip.countKey] ?? 0;
          return (
            <button
              key={chip.id}
              type="button"
              onClick={() => selectStageChip(chip)}
              disabled={count === 0 && !active}
              className={`inline-flex items-center gap-1.5 text-[11px] px-2 py-0.5 rounded-full border transition-colors ${
                active
                  ? "bg-[var(--brand)] text-white border-[var(--brand)] font-medium"
                  : count === 0
                    ? "bg-surface text-text-3 border-border opacity-50 cursor-not-allowed"
                    : "bg-surface text-text-2 border-border hover:bg-[var(--surface-2)]"
              }`}
            >
              {chip.label}
              {count > 0 && (
                <span className={`tabular-nums ${active ? "text-white/80" : "text-text-3"}`}>{count}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Row 5 — ATS: ATS >= 70, ATS 60-69, ATS < 60 */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span
          className="text-[10px] uppercase font-semibold text-text-3 tracking-wider mr-1 w-12 shrink-0"
          title={`ATS gates: initial ${thresholds.initial} (must pass to tailor), final ${thresholds.final} (auto cover letter)`}
        >
          ATS
        </span>
        {atsBands.filter(b => b.id !== "no_ats").map((b) => {
          const active = currentAts === b.id;
          const count  = atsCounts[b.id] ?? 0;
          return (
            <button
              key={b.id}
              type="button"
              onClick={() => selectAtsChip(b.id)}
              title={b.tip}
              disabled={count === 0 && !active}
              className={`inline-flex items-center gap-1.5 text-[11px] px-2 py-0.5 rounded-full border transition-colors ${
                active
                  ? `${b.chipBg} ${b.chipText} border-current font-medium`
                  : count === 0
                    ? "bg-surface text-text-3 border-border opacity-50 cursor-not-allowed"
                    : "bg-surface text-text-2 border-border hover:bg-[var(--surface-2)]"
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${b.dot}`} />
              {b.label}
              {count > 0 && (
                <span className={`tabular-nums ${active ? "" : "text-text-3"}`}>{count}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

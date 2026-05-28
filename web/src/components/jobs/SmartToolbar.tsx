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
import { Search, X } from "lucide-react";
import type { FunnelCounts } from "./PipelineFunnel";
import type { AtsBand } from "./jobFilters";
import { shallowSetParams } from "./shallowNav";

// Sort options — mirror the legacy SmartFilterBar so URLs stay compatible.
const SORT_OPTIONS = [
  { value: "posted_at",           label: "Date posted" },
  { value: "created_at",          label: "Date added" },
  { value: "rich_jd_first",       label: "Rich JD first" },
  { value: "recently_progressed", label: "Recently progressed" },
  { value: "most_progressed",     label: "Most progressed" },
  { value: "distance",            label: "Distance (nearest)" },
] as const;

const DISTANCE_OPTIONS = [
  { value: "",    label: "Any distance" },
  { value: "5",   label: "Within 5 km" },
  { value: "10",  label: "Within 10 km" },
  { value: "25",  label: "Within 25 km" },
  { value: "50",  label: "Within 50 km" },
  { value: "100", label: "Within 100 km" },
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

const STAGE_CHIPS: StageChip[] = [
  { id: "thinJd",      label: "Thin JD",      kind: "stage",  value: "thinJd",      countKey: "thinJd"      },
  { id: "richJd",      label: "Full JD",      kind: "triage", value: "richJd",      countKey: "richJd"      },
  { id: "analysed",    label: "Analysed",     kind: "stage",  value: "analysed",    countKey: "analysed"    },
  { id: "cvReady",     label: "CV ready",     kind: "stage",  value: "cvReady",     countKey: "cvReady"     },
  { id: "letterReady", label: "Letter ready", kind: "stage",  value: "letterReady", countKey: "letterReady" },
  { id: "applied",     label: "Applied",      kind: "stage",  value: "applied",     countKey: "applied"     },
  { id: "dismissed",   label: "Archived",     kind: "stage",  value: "dismissed",   countKey: "dismissed"   },
];

// ATS bands — uses lib/atsThresholds globals at 60 / 70.
const ATS_BANDS: { id: AtsBand; label: string; tip: string; dot: string; chipBg: string; chipText: string }[] = [
  { id: "above_final",   label: "ATS ≥ 70",     tip: "Above the final gate (70) — auto cover letter eligible", dot: "bg-green-500", chipBg: "bg-green-100",          chipText: "text-green-800" },
  { id: "below_final",   label: "ATS 60–69",    tip: "Between gates — tailored CV, no auto cover letter",      dot: "bg-amber-500", chipBg: "bg-amber-100",          chipText: "text-amber-800" },
  { id: "below_initial", label: "ATS < 60",     tip: "Below the initial gate (60) — pipeline stopped",         dot: "bg-red-500",   chipBg: "bg-red-100",            chipText: "text-red-800"   },
  { id: "no_ats",        label: "Not analysed", tip: "No ATS score yet — click Analyze on the card",           dot: "bg-gray-300",  chipBg: "bg-[var(--surface-2)]", chipText: "text-text-2"    },
];

// View-filter URL keys → committed via the History API for instant feedback.
// Dataset narrowers (location / posted_within / source) hit the real router.
const SHALLOW_KEYS = new Set(["stage", "triage", "ats", "sort", "dir", "min_keywords", "max_distance"]);

export function SmartToolbar({
  counts,
  atsCounts,
  homeAddress = null,
}: {
  counts:       FunnelCounts;
  atsCounts:    Record<AtsBand, number>;
  /** When set (per-profile board with home_address), the "Within X km"
   *  distance select renders. */
  homeAddress?: string | null;
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
  const currentDistance = sp.get("max_distance") || "";

  function commit(params: URLSearchParams, key: string) {
    if (SHALLOW_KEYS.has(key)) shallowSetParams(pathname, params);
    else startTransition(() => router.replace(`${pathname}?${params}`, { scroll: false }));
  }

  function setOne(key: string, value: string) {
    const next = new URLSearchParams(Array.from(sp.entries()));
    if (value) next.set(key, value); else next.delete(key);
    commit(next, key);
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

  return (
    <div className="rounded-md border border-border bg-surface p-3 space-y-3">
      {/* Row 1 — location search, sort, optional distance */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-3 pointer-events-none" />
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
            className="field pl-9 pr-8 text-[12px]"
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

        {homeAddress && (
          <label className="flex items-center gap-1.5 text-[11px] text-text-2 shrink-0">
            Distance
            <select
              value={currentDistance}
              onChange={(e) => setOne("max_distance", e.target.value)}
              className="field text-[12px] py-1 pr-7"
              title={`Distance from ${homeAddress}`}
            >
              {DISTANCE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
        )}
      </div>

      {/* Row 2 — stage chips with live counts */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] uppercase font-semibold text-text-3 tracking-wider mr-1 w-12 shrink-0">Stage</span>
        {STAGE_CHIPS.map((chip) => {
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
              <span className={`tabular-nums ${active ? "text-white/80" : "text-text-3"}`}>{count}</span>
            </button>
          );
        })}
      </div>

      {/* Row 3 — ATS band chips with counts, colour-coded per band */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span
          className="text-[10px] uppercase font-semibold text-text-3 tracking-wider mr-1 w-12 shrink-0"
          title="Global ATS gates: initial 60 (must pass to tailor), final 70 (auto cover letter)"
        >
          ATS
        </span>
        {ATS_BANDS.map((b) => {
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
              <span className={`tabular-nums ${active ? "" : "text-text-3"}`}>{count}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

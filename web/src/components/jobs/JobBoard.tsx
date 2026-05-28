"use client";

import { useMemo } from "react";
import Link from "next/link";
import { useSearchParams, usePathname } from "next/navigation";
import { Sparkles, BarChart3, FileText, Mail, CheckCircle2, FileWarning, Archive, ArrowRight } from "lucide-react";
import { type FunnelCounts } from "./PipelineFunnel";
import { ContinueRail, type RailJob } from "./ContinueRail";
import { SmartFeed } from "./SmartFeed";
import { BulkThinJdButton, type ThinJdJob } from "./BulkThinJdButton";
import { filterJobs, sortJobs, FILTER_LABELS, type BoardJob, type AtsBand } from "./jobFilters";
import { shallowSetParams } from "./shallowNav";

/** Client-side resolveStage — mirrors the server's mapping of legacy params. */
function resolveStage(sp: URLSearchParams): string {
  const stage = sp.get("stage");
  if (stage) return stage;
  const status = sp.get("status");
  if (status === "applied") return "applied";
  if (status === "dismissed") return "dismissed";
  const chips = sp.get("chips") ?? "";
  if (chips.includes("analysed") && chips.includes("hasLetter")) return "letterReady";
  if (chips.includes("analysed") && chips.includes("hasCv")) return "cvReady";
  if (chips.includes("analysed")) return "analysed";
  return "all";
}

// ── Suggested sort per stage ────────────────────────────────────────────
// Nudges the most useful sort when the user clicks a stage in the funnel.
// Click the pill to apply — never auto-changes the URL.
const SUGGESTED_SORT: Record<string, { col: string; label: string } | undefined> = {
  analysed:     { col: "most_progressed",     label: "Most progressed" },
  cvReady:      { col: "most_progressed",     label: "Most progressed" },
  letterReady:  { col: "most_progressed",     label: "Most progressed" },
  thinJd:       { col: "created_at",          label: "Date added (newest)" },
  applied:      { col: "recently_progressed", label: "Recently progressed" },
};

// Stage icon for the big-title heading.
const STAGE_ICON: Record<string, typeof BarChart3> = {
  analysed:    BarChart3,
  cvReady:     FileText,
  letterReady: Mail,
  applied:     CheckCircle2,
  thinJd:      FileWarning,
  dismissed:   Archive,
};

// Human label for the current sort column — mirrors SmartFilterBar's options.
const SORT_LABEL_FOR_COL: Record<string, string> = {
  posted_at:           "Date posted",
  created_at:          "Date added",
  rich_jd_first:       "Rich JD first",
  recently_progressed: "Recently progressed",
  most_progressed:     "Most progressed",
  distance:            "Distance (nearest)",
};

/**
 * Client job board. The server fetches the (capped) non-dismissed job set once
 * and hands it here with each job's precomputed ATS band. View filters
 * (stage / triage / ATS / keywords / sort / visa) are applied in-memory and
 * driven by the URL via the History API, so changing them is instant — no
 * server round-trip. Dataset filters (location / time / source / dismissed)
 * still go through the server (they change which jobs are fetched).
 */
export function JobBoard({
  jobs,
  counts,
  railJobs,
  thinJdJobs,
  sourceParam,
}: {
  jobs:        BoardJob[];
  counts:      FunnelCounts;
  railJobs:    RailJob[];
  thinJdJobs:  ThinJdJob[];
  sourceParam?: string;
}) {
  const sp = useSearchParams();
  const pathname = usePathname();

  const stage       = resolveStage(sp);
  const triage      = sp.get("triage") || "";
  const ats         = sp.get("ats") || "";
  const minKeywords = sp.get("min_keywords") || "";
  const sortCol     = sp.get("sort") || "posted_at";
  const asc         = sp.get("dir") === "asc";
  // SmartFeed surfaces visa as an always-visible coloured dot on every card,
  // so the legacy ?visa_toggle= column flag is no longer read here.

  const filtered = useMemo(
    // Unified dashboard spans multiple profiles, each with its own home_address —
    // no single origin makes sense here, so the distance filter is always off
    // (passed empty). The chip still renders per-job for context.
    () => sortJobs(filterJobs(jobs, { stage, triage, ats, minKeywords, maxDistance: "" }), sortCol, asc),
    [jobs, stage, triage, ats, minKeywords, sortCol, asc],
  );

  // ATS-band counts derived from the *unfiltered* loaded set — used by the
  // toolbar's chip badges so users see what they can filter to.
  const atsCounts = useMemo<Record<AtsBand, number>>(() => {
    const out: Record<AtsBand, number> = { above_final: 0, below_final: 0, below_initial: 0, no_ats: 0 };
    for (const j of jobs) out[j.atsBand]++;
    return out;
  }, [jobs]);

  // Active view-filter labels for the heading (dismissed = a server tab, not a
  // view filter, so it isn't shown as a removable chip here).
  const activeFilters: string[] = [];
  if (stage !== "all" && stage !== "dismissed") activeFilters.push(FILTER_LABELS[stage] ?? stage);
  if (triage) activeFilters.push(FILTER_LABELS[triage] ?? triage);
  if (ats)    activeFilters.push(FILTER_LABELS[ats] ?? ats);

  const hasActiveFilter = activeFilters.length > 0;

  // Suggested sort pill for the active stage. Only shown when:
  //   - a stage filter is active
  //   - there's a suggestion for that stage
  //   - the current sort is NOT already the suggested one
  const suggestion = hasActiveFilter ? SUGGESTED_SORT[stage] : undefined;
  const showSuggestion = !!suggestion && suggestion.col !== sortCol;

  function applySuggestion() {
    if (!suggestion) return;
    const params = new URLSearchParams(Array.from(sp.entries()));
    params.set("sort", suggestion.col);
    params.delete("dir"); // suggestions default to descending
    shallowSetParams(pathname, params);
  }

  // Sort context line for the big-title heading. Hidden when sort is default.
  const sortLabel = sortCol === "posted_at" ? null : (SORT_LABEL_FOR_COL[sortCol] ?? sortCol);

  // Stage icon (only when filtering by a stage)
  const StageIcon = STAGE_ICON[stage];

  return (
    <>
      {/* ── Headline row ─────────────────────────────────────────────────
          Two modes:
            · No filter  → small "All jobs across profiles" header (unchanged)
            · Filter on  → BIG 28px brand-coloured heading with stage icon,
                           the count, sort-context subtitle, and a suggested
                           sort pill when relevant. */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-baseline gap-2.5 flex-wrap">
          {hasActiveFilter ? (
            <>
              {StageIcon && (
                <StageIcon className="w-6 h-6 self-center" style={{ color: "var(--brand)" }} strokeWidth={2.5} />
              )}
              <h2 className="text-[28px] font-bold leading-tight tracking-tight" style={{ color: "var(--brand)" }}>
                {activeFilters.join(" · ")}
              </h2>
              <span className="text-[22px] font-bold tabular-nums" style={{ color: "var(--brand)" }}>
                {filtered.length}
              </span>
              {sortLabel && (
                <span className="text-[12px] text-text-2 font-medium">
                  · sorted by <span className="text-text">{sortLabel}</span>
                </span>
              )}
              {showSuggestion && (
                <button
                  type="button"
                  onClick={applySuggestion}
                  title={`Recommended sort for ${activeFilters[0]}`}
                  className="inline-flex items-center gap-1 rounded-full bg-[var(--surface-2)] border border-[var(--brand)]/40 px-2.5 py-0.5 text-[11px] font-medium text-[var(--brand)] hover:bg-[var(--brand)] hover:text-white transition-colors"
                >
                  <Sparkles className="w-3 h-3" />
                  Suggest sort: {suggestion!.label}
                  <ArrowRight className="w-3 h-3" />
                </button>
              )}
              <Link
                href="/dashboard"
                className="inline-flex items-center gap-1 rounded-full border border-[var(--brand)]/40 px-2.5 py-0.5 text-[12px] font-medium hover:bg-[var(--surface-2)] transition-colors"
                style={{ color: "var(--brand)" }}
              >
                <span>Clear filter</span>
                <span aria-hidden>✕</span>
              </Link>
            </>
          ) : (
            <>
              <h2 className="text-[14px] font-semibold text-text">All jobs across profiles</h2>
              <span className="text-[12px] text-text-3">{filtered.length}</span>
              {sortLabel && (
                <span className="text-[11px] text-text-3">· sorted by {sortLabel}</span>
              )}
            </>
          )}
          {sourceParam && (
            <Link
              href="/dashboard"
              className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-text-2 hover:text-text transition-colors"
            >
              <span className="capitalize">Source: {sourceParam}</span>
              <span aria-hidden>✕</span>
            </Link>
          )}
        </div>
        <BulkThinJdButton jobs={thinJdJobs} />
      </div>

      <ContinueRail jobs={railJobs} currentTab={stage} />

      {/* Card-based smart feed with embedded SmartToolbar (location search,
          sort dropdown, stage chips, ATS band chips — replaces the old
          PipelineFunnel + SmartFilterBar). When no view filter is active,
          renders smart sections (Today's picks · Closest · Fresh · Needs
          attention · Everything else). When filtered, renders a flat card
          list sorted by the toolbar's sort dropdown. */}
      <SmartFeed
        jobs={filtered}
        hasActiveFilter={hasActiveFilter}
        currentTab={stage}
        counts={counts}
        atsCounts={atsCounts}
      />
    </>
  );
}

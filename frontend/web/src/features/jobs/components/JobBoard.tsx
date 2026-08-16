"use client";

import { useMemo } from "react";
import Link from "next/link";
import { useSearchParams, usePathname } from "next/navigation";
import { Sparkles, BarChart3, FileText, Mail, FileWarning, Archive, ArrowRight } from "lucide-react";
import { type FunnelCounts } from "./PipelineFunnel";
import { SmartFeed } from "./SmartFeed";
import { filterJobs, sortJobs, FILTER_LABELS, filterLabelsFor, pickGroupMode, buildGroups, resolveStage, type BoardJob } from "../lib/jobFilters";
import { useToolbarCounts } from "../lib/useToolbarCounts";
import { shallowSetParams } from "../lib/shallowNav";
import { ThinJdModal } from "./ThinJdModal";

// ── Suggested sort per stage ────────────────────────────────────────────
// Nudges the most useful sort when the user clicks a stage in the funnel.
// Click the pill to apply — never auto-changes the URL.
// `applied`/`favourite` have no entries here — their headline row (which is
// what these fed) is hidden entirely for those two stages (see isFlatStage).
const SUGGESTED_SORT: Record<string, { col: string; label: string } | undefined> = {
  analysed:     { col: "most_progressed",     label: "Most progressed" },
  cvReady:      { col: "most_progressed",     label: "Most progressed" },
  letterReady:  { col: "most_progressed",     label: "Most progressed" },
  thinJd:       { col: "created_at",          label: "Date added (newest)" },
};

// Stage icon for the big-title heading.
const STAGE_ICON: Record<string, typeof BarChart3> = {
  analysed:         BarChart3,
  recentlyAnalysed: BarChart3,
  cvReady:          FileText,
  letterReady:      Mail,
  thinJd:           FileWarning,
  dismissed:        Archive,
};

// Human label for the current sort column — mirrors SmartFilterBar's options.
const SORT_LABEL_FOR_COL: Record<string, string> = {
  posted_at:           "Date posted",
  created_at:          "Date added",
  rich_jd_first:       "Rich JD first",
  recently_progressed: "Recently progressed",
  most_progressed:     "Most progressed",
  distance:            "Distance (nearest)",
  ats_score:           "ATS score",
  last_analysed:       "Recently analysed",
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
  sourceParam,
  excludeKeywords,
}: {
  jobs:        BoardJob[];
  counts:      FunnelCounts;
  sourceParam?: string;
  excludeKeywords?: string;
}) {
  const sp = useSearchParams();
  const pathname = usePathname();

  const stage       = resolveStage(sp);
  const triage      = sp.get("triage") || "";
  const ats         = sp.get("ats") || "";
  const jd          = sp.get("jd") || "";
  const notApplied  = sp.get("not_applied") || "";
  const minKeywords = sp.get("min_keywords") || "";
  const maxDistance = sp.get("max_distance") || "";
  const minDistance = sp.get("min_distance") || "";
  // Applied has no Sort dropdown of its own (SmartFeed renders it as a flat,
  // curated list — see isFlatStage there), so its default has to be set here
  // rather than picked from the toolbar. "Recently analysed" surfaces the
  // jobs whose tailored CV/score most recently changed first, which is what
  // you want when checking back on applications already sent.
  const sortCol     = sp.get("sort") || (stage === "applied" ? "last_analysed" : "posted_at");
  const asc         = sp.get("dir") === "asc";
  // SmartFeed surfaces visa as an always-visible coloured dot on every card,
  // so the legacy ?visa_toggle= column flag is no longer read here.

  const filtered = useMemo(
    // Dashboard spans multiple profiles but each job carries its own
    // distance_km from its profile's home_address, so the range filter
    // (min/max km) still applies meaningfully across the global feed.
    () => sortJobs(filterJobs(jobs, { stage, triage, ats, jd, notApplied, minKeywords, maxDistance, minDistance, sort: sortCol }), sortCol, asc),
    [jobs, stage, triage, ats, jd, notApplied, minKeywords, maxDistance, minDistance, sortCol, asc],
  );

  // Group mode is decided from the URL state — Analysed/Not-analysed → time
  // buckets, CV/Letter/Applied + sort=distance → distance buckets. Once a
  // grouping is active, jobs inside each bucket honour the current sort.
  // Applied/Favourite render as SmartFeed's flat accordion list regardless
  // (see isFlatStage there) and never read this prop — skip the computation.
  const groups = useMemo(
    () => (stage === "favourite" || stage === "applied" ? null : buildGroups(filtered, pickGroupMode({ stage, ats, sortCol }))),
    [filtered, stage, ats, sortCol],
  );

  // Every badge in the toolbar equals what clicking it will actually show —
  // see useToolbarCounts for the rule.
  const { atsCounts, viewCounts, postedWithinCounts } = useToolbarCounts(jobs, {
    stage, triage, jd, notApplied, minKeywords, maxDistance, minDistance, sortCol,
    postedWithin: sp.get("posted_within") || "",
  });

  // Active view-filter labels for the heading (dismissed = a server tab, not a
  // view filter, so it isn't shown as a removable chip here).
  const activeFilters: string[] = [];
  if (stage !== "all" && stage !== "dismissed") activeFilters.push(FILTER_LABELS[stage] ?? stage);
  if (triage) activeFilters.push(FILTER_LABELS[triage] ?? triage);
  if (ats)    activeFilters.push(...filterLabelsFor(ats));
  if (jd)     activeFilters.push(...filterLabelsFor(jd));

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
      {/* Favourite/Applied are their own sidebar destinations with a flat,
          curated list (see SmartFeed's isFlatStage) — no heading, count, sort
          subtitle, or "clear filter" chip to layer on top; the sidebar nav
          itself is the way in and out. */}
      {stage !== "favourite" && stage !== "applied" && (
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-baseline gap-2.5 flex-wrap">
          {hasActiveFilter ? (
            <>
              {StageIcon && (
                <StageIcon className="w-6 h-6 self-center" style={{ color: "var(--brand)" }} strokeWidth={2.5} />
              )}
              <h2 className="text-h1 sm:text-display font-bold leading-tight tracking-tight" style={{ color: "var(--brand)" }}>
                {activeFilters.join(" · ")}
              </h2>
              <span className="text-h3 sm:text-h1 font-bold tabular-nums" style={{ color: "var(--brand)" }}>
                {filtered.length}
              </span>
              {sortLabel && (
                <span className="text-label text-text-2 font-medium">
                  · sorted by <span className="text-text">{sortLabel}</span>
                </span>
              )}
              {showSuggestion && (
                <button type="button" onClick={applySuggestion} title={`Recommended sort for ${activeFilters[0]}`} className="inline-flex items-center gap-1 rounded-full bg-[var(--surface-2)] border border-[var(--brand)]/40 px-2.5 py-1 text-caption font-medium text-[var(--brand)] hover:bg-[var(--brand)] hover:text-[var(--brand-fg)] transition-colors">
                  <Sparkles className="w-3 h-3" />
                  Suggest sort: {suggestion!.label}
                  <ArrowRight className="w-3 h-3" />
                </button>
              )}
              <Link
                href="/dashboard"
                className="inline-flex items-center gap-1 rounded-full border border-[var(--brand)]/40 px-2.5 py-1 text-label font-medium hover:bg-[var(--surface-2)] transition-colors"
                style={{ color: "var(--brand)" }}
              >
                <span>Clear filter</span>
                <span aria-hidden>✕</span>
              </Link>
            </>
          ) : (
            <>
              <h2 className="text-title font-semibold text-text">All jobs across profiles</h2>
              <span className="text-label text-text-3">{filtered.length}</span>
              {sortLabel && (
                <span className="text-caption text-text-3">· sorted by {sortLabel}</span>
              )}
            </>
          )}
          {sourceParam && (
            <Link
              href="/dashboard"
              className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-2 px-2 py-0.5 text-caption font-medium text-text-2 hover:text-text transition-colors"
            >
              <span className="capitalize">Source: {sourceParam}</span>
              <span aria-hidden>✕</span>
            </Link>
          )}
        </div>
      </div>
      )}

      <ThinJdModal count={counts.thinJd} />


      {/* Card-based smart feed with embedded SmartToolbar (location search,
          sort dropdown, stage chips, ATS band chips — replaces the old
          PipelineFunnel + SmartFilterBar). When no view filter is active,
          renders smart sections (Closest · Fresh · Needs
          attention · Everything else). When filtered, renders a flat card
          list sorted by the toolbar's sort dropdown. */}
      {/* When the user picks any sort other than the default "Date posted",
          skip the smart-section grouping (Closest / Fresh /
          …) and just render a single sorted list — the chosen sort order
          is the whole point. */}
      <SmartFeed
        jobs={filtered}
        groups={groups ?? undefined}
        hasActiveFilter={hasActiveFilter || !!sp.get("sort")}
        currentTab={stage}
        counts={counts}
        atsCounts={atsCounts}
        viewCounts={viewCounts}
        postedWithinCounts={postedWithinCounts}
        excludeKeywords={excludeKeywords}
      />
    </>
  );
}

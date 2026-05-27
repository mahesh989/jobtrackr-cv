"use client";

import { useMemo } from "react";
import Link from "next/link";
import { useSearchParams, usePathname } from "next/navigation";
import { Sparkles, MapPin, Clock, AlertTriangle, Inbox, BarChart3, FileText, Mail, CheckCircle2, FileWarning, Archive, ArrowRight } from "lucide-react";
import { PipelineFunnel, type FunnelCounts } from "./PipelineFunnel";
import { SmartFilterBar } from "./SmartFilterBar";
import { ContinueRail, type RailJob } from "./ContinueRail";
import { JobTable, type JobTableSection } from "./JobTable";
import { BulkThinJdButton, type ThinJdJob } from "./BulkThinJdButton";
import { filterJobs, sortJobs, FILTER_LABELS, type BoardJob } from "./jobFilters";
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

// ── Smart sections (only used when no view filter is active) ────────────

/** Tiny opinionated score used to pick "Today's picks". Higher = better.
 *  Distance closer wins, fresher wins, jobs with completed analysis
 *  (especially passing the final gate) bubble up. Already-applied jobs are
 *  hard-demoted because they're not actionable in the picks rail. */
function pickScore(j: BoardJob): number {
  let s = 50;
  if (j.distance_km != null) s += Math.max(0, 30 - j.distance_km * 0.7);
  if (j.atsBand === "above_final")   s += 25;
  else if (j.atsBand === "below_final")   s += 5;
  else if (j.atsBand === "below_initial") s -= 12;
  if (j.jd_quality === "thin") s -= 8;
  // Freshness from posted_at
  const posted = j.posted_at ? new Date(j.posted_at).getTime() : 0;
  if (posted) {
    const days = (Date.now() - posted) / 86400000;
    if (days < 1)  s += 10;
    else if (days > 21) s -= 8;
  }
  if (j.applied_at)   s -= 100;
  if (j.dismissed_at) s -= 100;
  return s;
}

function isPostedToday(j: BoardJob): boolean {
  if (!j.posted_at) return false;
  const d = new Date(j.posted_at);
  const now = new Date();
  return d.getFullYear() === now.getFullYear()
      && d.getMonth()    === now.getMonth()
      && d.getDate()     === now.getDate();
}

/** Bucket the loaded jobs into 5 disjoint sections with priority:
 *    picks > closest (≤15km) > fresh today > thin JD > everything else
 *  Each job appears in exactly one section. */
function bucketJobs(jobs: BoardJob[]): JobTableSection[] {
  if (jobs.length === 0) return [];
  const active = jobs.filter((j) => !j.applied_at && !j.dismissed_at);
  const placed = new Set<string>();

  const picks = [...active]
    .sort((a, b) => pickScore(b) - pickScore(a))
    .slice(0, 3);
  picks.forEach((j) => placed.add(j.id));

  const closest = active
    .filter((j) => !placed.has(j.id) && j.distance_km != null && j.distance_km <= 15)
    .sort((a, b) => (a.distance_km ?? 0) - (b.distance_km ?? 0));
  closest.forEach((j) => placed.add(j.id));

  const fresh = active.filter((j) => !placed.has(j.id) && isPostedToday(j));
  fresh.forEach((j) => placed.add(j.id));

  const attention = active.filter((j) => !placed.has(j.id) && j.jd_quality === "thin");
  attention.forEach((j) => placed.add(j.id));

  const rest = jobs.filter((j) => !placed.has(j.id));

  const sections: JobTableSection[] = [];
  if (picks.length     > 0) sections.push({ label: "Today's picks",   caption: "Best matches across distance, ATS band, and freshness", tone: "brand", icon: Sparkles,         jobs: picks });
  if (closest.length   > 0) sections.push({ label: "Closest to you",  caption: "Within 15 km of your profile's home address",            tone: "green", icon: MapPin,           jobs: closest });
  if (fresh.length     > 0) sections.push({ label: "Fresh today",     caption: "Posted in the last 24 hours",                            tone: "brand", icon: Clock,            jobs: fresh });
  if (attention.length > 0) sections.push({ label: "Needs attention", caption: "Thin JDs — open and paste the full description",         tone: "amber", icon: AlertTriangle,    jobs: attention });
  if (rest.length      > 0) sections.push({ label: "Everything else", caption: "Older, further away, applied, or dismissed",             tone: "muted", icon: Inbox,            jobs: rest });
  return sections;
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
  const showVisa    = sp.get("visa_toggle") === "1";

  const filtered = useMemo(
    // Unified dashboard spans multiple profiles, each with its own home_address —
    // no single origin makes sense here, so the distance filter is always off
    // (passed empty). The chip still renders per-job for context.
    () => sortJobs(filterJobs(jobs, { stage, triage, ats, minKeywords, maxDistance: "" }), sortCol, asc),
    [jobs, stage, triage, ats, minKeywords, sortCol, asc],
  );

  // Active view-filter labels for the heading (dismissed = a server tab, not a
  // view filter, so it isn't shown as a removable chip here).
  const activeFilters: string[] = [];
  if (stage !== "all" && stage !== "dismissed") activeFilters.push(FILTER_LABELS[stage] ?? stage);
  if (triage) activeFilters.push(FILTER_LABELS[triage] ?? triage);
  if (ats)    activeFilters.push(FILTER_LABELS[ats] ?? ats);

  const hasActiveFilter = activeFilters.length > 0;

  // Smart sections — only when nothing is filtered (stage=all + no triage/ats
  // chips). The bucketing runs on the loaded, sorted set so user sort choices
  // still influence within-section ordering for the "rest" bucket.
  const sections = useMemo<JobTableSection[] | undefined>(
    () => (hasActiveFilter ? undefined : bucketJobs(filtered)),
    [filtered, hasActiveFilter],
  );

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

      <PipelineFunnel counts={counts} currentStage={stage} excludeStages={["all", "applied"]} shallow />

      <SmartFilterBar total={filtered.length} showKeywords={false} showAtsFilter shallow />

      <ContinueRail jobs={railJobs} currentTab={stage} />

      {/* Smart-section view kicks in only when no view filter is active.
          When filtered, the table renders flat — exactly as before. */}
      <JobTable
        jobs={filtered}
        showVisa={showVisa}
        currentTab={stage}
        sections={sections}
      />
    </>
  );
}

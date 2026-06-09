"use client";

import { useMemo, useRef, useEffect } from "react";
import Link from "next/link";
import { useSearchParams, usePathname } from "next/navigation";
import { Sparkles, BarChart3, FileText, Mail, CheckCircle2, FileWarning, Archive, ArrowRight } from "lucide-react";
import { type FunnelCounts } from "./PipelineFunnel";
import { ContinueRail, type RailJob } from "./ContinueRail";
import { SmartFeed } from "./SmartFeed";
import { filterJobs, sortJobs, FILTER_LABELS, pickGroupMode, buildGroups, type BoardJob, type AtsBand } from "./jobFilters";
import { shallowSetParams } from "./shallowNav";
import { type AtsThresholds } from "@/lib/atsThresholds";

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

// Suggested sort per stage — same as the dashboard JobBoard.
const SUGGESTED_SORT: Record<string, { col: string; label: string } | undefined> = {
  analysed:     { col: "most_progressed",     label: "Most progressed" },
  cvReady:      { col: "most_progressed",     label: "Most progressed" },
  letterReady:  { col: "most_progressed",     label: "Most progressed" },
  thinJd:       { col: "created_at",          label: "Date added (newest)" },
  applied:      { col: "recently_progressed", label: "Recently progressed" },
};

const STAGE_ICON: Record<string, typeof BarChart3> = {
  analysed:    BarChart3,
  cvReady:     FileText,
  letterReady: Mail,
  applied:     CheckCircle2,
  thinJd:      FileWarning,
  dismissed:   Archive,
};

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
 * Per-profile job board — same SmartFeed + SmartToolbar combo as the
 * dashboard. Differences:
 *   - homeAddress is passed through, so the toolbar renders the "Within X km"
 *     distance dropdown.
 *   - On stage change, scrolls the feed back into view (carry-over from the
 *     pre-redesign behaviour: a funnel click should move focus to the list).
 */
export function ProfileJobBoard({
  jobs,
  counts,
  railJobs,
  homeAddress = null,
  thresholds,
  isManual = false,
}: {
  jobs:        BoardJob[];
  counts:      FunnelCounts;
  railJobs:    RailJob[];
  /** Profile's home_address (Migration 048). When set, the toolbar shows the
   *  "Within X km" distance filter and the distance ribbon renders. */
  homeAddress?: string | null;
  thresholds?:  AtsThresholds;
  /** When true (Saved Jobs profile), always renders flat list — no smart sections. */
  isManual?:    boolean;
}) {
  const sp = useSearchParams();
  const pathname = usePathname();

  const stage       = resolveStage(sp);
  const triage      = sp.get("triage") || "";
  const ats         = sp.get("ats") || "";
  const minKeywords = sp.get("min_keywords") || "";
  const maxDistance = sp.get("max_distance") || "";
  const minDistance = sp.get("min_distance") || "";
  const sortCol     = sp.get("sort") || "posted_at";
  const asc         = sp.get("dir") === "asc";

  const filtered = useMemo(
    () => sortJobs(filterJobs(jobs, { stage, triage, ats, minKeywords, maxDistance, minDistance, sort: sortCol }), sortCol, asc),
    [jobs, stage, triage, ats, minKeywords, maxDistance, minDistance, sortCol, asc],
  );

  // Group mode mirrors JobBoard — Analysed/Not-analysed → time buckets;
  // CV/Letter/Applied + sort=distance → distance buckets. Saved-Jobs profile
  // (isManual) skips grouping entirely so the manual list stays flat.
  const groups = useMemo(
    () => (isManual ? null : buildGroups(filtered, pickGroupMode({ stage, ats, sortCol }))),
    [filtered, stage, ats, sortCol, isManual],
  );

  const atsCounts = useMemo<Record<AtsBand, number>>(() => {
    const out: Record<AtsBand, number> = { above_final: 0, below_final: 0, below_initial: 0, no_ats: 0 };
    for (const j of jobs) out[j.atsBand]++;
    return out;
  }, [jobs]);

  // Scroll to the feed whenever the stage changes (carries over from the
  // pre-redesign behaviour where clicking a funnel stage scrolled to the
  // table). Now the SmartFeed handles in-card scrolling via the distance
  // ribbon, so this only fires on stage transitions.
  const feedRef    = useRef<HTMLDivElement>(null);
  const prevStage  = useRef(stage);
  useEffect(() => {
    if (prevStage.current !== stage) {
      prevStage.current = stage;
      feedRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [stage]);

  // Active view-filter labels for the heading.
  const activeFilters: string[] = [];
  if (stage !== "all" && stage !== "dismissed") activeFilters.push(FILTER_LABELS[stage] ?? stage);
  if (triage) activeFilters.push(FILTER_LABELS[triage] ?? triage);
  if (ats)    activeFilters.push(FILTER_LABELS[ats] ?? ats);

  const hasActiveFilter = activeFilters.length > 0;

  const suggestion = hasActiveFilter ? SUGGESTED_SORT[stage] : undefined;
  const showSuggestion = !!suggestion && suggestion.col !== sortCol;

  function applySuggestion() {
    if (!suggestion) return;
    const params = new URLSearchParams(Array.from(sp.entries()));
    params.set("sort", suggestion.col);
    params.delete("dir");
    shallowSetParams(pathname, params);
  }

  const sortLabel = sortCol === "posted_at" ? null : (SORT_LABEL_FOR_COL[sortCol] ?? sortCol);
  const StageIcon = STAGE_ICON[stage];

  return (
    <>
      {/* Headline row — same big-title treatment as the dashboard */}
      <div ref={feedRef} className="flex items-baseline gap-2.5 flex-wrap mb-3">
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
              href="?"
              className="inline-flex items-center gap-1 rounded-full border border-[var(--brand)]/40 px-2.5 py-0.5 text-[12px] font-medium hover:bg-[var(--surface-2)] transition-colors"
              style={{ color: "var(--brand)" }}
            >
              <span>Clear filter</span>
              <span aria-hidden>✕</span>
            </Link>
          </>
        ) : (
          <>
            <span className="text-[14px] font-semibold text-text">All jobs</span>
            <span className="text-[12px] text-text-3">{filtered.length}</span>
            {sortLabel && (
              <span className="text-[11px] text-text-3">· sorted by {sortLabel}</span>
            )}
          </>
        )}
      </div>

      <ContinueRail jobs={railJobs} currentTab={stage} />

      {/* When the user picks any sort other than the default "Date posted",
          skip the smart-section grouping (Today's picks / Closest / Fresh /
          …) and just render a single sorted list — the chosen sort order
          is the whole point. */}
      <SmartFeed
        jobs={filtered}
        groups={groups ?? undefined}
        hasActiveFilter={isManual || hasActiveFilter || sortCol !== "posted_at"}
        currentTab={stage}
        counts={counts}
        atsCounts={atsCounts}
        homeAddress={homeAddress}
        thresholds={thresholds}
      />
    </>
  );
}

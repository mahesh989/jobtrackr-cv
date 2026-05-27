"use client";

import { useMemo } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { PipelineFunnel, type FunnelCounts } from "./PipelineFunnel";
import { SmartFilterBar } from "./SmartFilterBar";
import { ContinueRail, type RailJob } from "./ContinueRail";
import { JobTable } from "./JobTable";
import { BulkThinJdButton, type ThinJdJob } from "./BulkThinJdButton";
import { filterJobs, sortJobs, FILTER_LABELS, type BoardJob } from "./jobFilters";

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

  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-baseline gap-2.5 flex-wrap">
          {activeFilters.length > 0 ? (
            <>
              <h2 className="text-[24px] font-bold leading-tight tracking-tight" style={{ color: "var(--brand)" }}>
                {activeFilters.join(" · ")}
              </h2>
              <span className="text-[20px] font-bold tabular-nums" style={{ color: "var(--brand)" }}>
                {filtered.length}
              </span>
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

      <JobTable jobs={filtered} showVisa={showVisa} currentTab={stage} />
    </>
  );
}

"use client";

import { useMemo, useRef, useEffect } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { PipelineFunnel, type FunnelCounts } from "./PipelineFunnel";
import { SmartFilterBar } from "./SmartFilterBar";
import { JobTable } from "./JobTable";
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
 * Client-side profile job board.
 *
 * The server fetches the (capped) non-dismissed job set once and passes it
 * here with each job's precomputed ATS band. Stage / triage / sort /
 * keywords filters are applied in-memory and driven by the URL via the
 * History API — clicking a funnel stage is instant with no server round-trip.
 *
 * Dataset filters (location / posted_within / dismissed) still go through
 * the server (they change which jobs are fetched).
 */
export function ProfileJobBoard({
  jobs,
  counts,
}: {
  jobs:     BoardJob[];
  counts:   FunnelCounts;
}) {
  const sp = useSearchParams();

  const stage       = resolveStage(sp);
  const triage      = sp.get("triage") || "";
  const minKeywords = sp.get("min_keywords") || "";
  const sortCol     = sp.get("sort") || "posted_at";
  const asc         = sp.get("dir") === "asc";
  const showVisa    = sp.get("visa_toggle") === "1";

  const filtered = useMemo(
    () => sortJobs(filterJobs(jobs, { stage, triage, ats: "", minKeywords }), sortCol, asc),
    [jobs, stage, triage, minKeywords, sortCol, asc],
  );

  // Scroll to the table section whenever the stage changes (i.e. after clicking
  // a funnel segment). Because the filter is client-side and instant, the DOM
  // update is synchronous and the scroll fires on the same frame.
  const tableRef   = useRef<HTMLDivElement>(null);
  const prevStage  = useRef(stage);
  useEffect(() => {
    if (prevStage.current !== stage) {
      prevStage.current = stage;
      tableRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [stage]);

  // Active view-filter labels for the heading.
  const activeFilters: string[] = [];
  if (stage !== "all" && stage !== "dismissed") activeFilters.push(FILTER_LABELS[stage] ?? stage);
  if (triage) activeFilters.push(FILTER_LABELS[triage] ?? triage);

  return (
    <>
      <PipelineFunnel counts={counts} currentStage={stage} shallow />

      <SmartFilterBar total={filtered.length} showKeywords showAtsFilter={false} shallow />

      {/* Table section — scrolled to when a funnel stage is clicked */}
      <div ref={tableRef}>
        {activeFilters.length > 0 ? (
          <div className="flex items-baseline gap-2.5 flex-wrap mb-3">
            <h2 className="text-[24px] font-bold leading-tight tracking-tight" style={{ color: "var(--brand)" }}>
              {activeFilters.join(" · ")}
            </h2>
            <span className="text-[20px] font-bold tabular-nums" style={{ color: "var(--brand)" }}>
              {filtered.length}
            </span>
            <Link
              href="?"
              className="inline-flex items-center gap-1 rounded-full border border-[var(--brand)]/40 px-2.5 py-0.5 text-[12px] font-medium hover:bg-[var(--surface-2)] transition-colors"
              style={{ color: "var(--brand)" }}
            >
              <span>Clear filter</span>
              <span aria-hidden>✕</span>
            </Link>
          </div>
        ) : (
          <div className="flex items-baseline gap-2 mb-3">
            <span className="text-[14px] font-semibold text-text">All jobs</span>
            <span className="text-[12px] text-text-3">{filtered.length}</span>
          </div>
        )}

        <JobTable jobs={filtered} showVisa={showVisa} currentTab={stage} />
      </div>
    </>
  );
}

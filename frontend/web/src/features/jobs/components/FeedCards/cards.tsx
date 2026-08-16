"use client";

/**
 * The card variants themselves, plus the empty state.
 *
 * Split out of the former single-file FeedCards.tsx (839 lines). Pure code
 * motion — component bodies and ordering are unchanged. Every component is
 * still importable from "./FeedCards".
 * 
 */
import { ChevronRight, ExternalLink, Inbox, Star } from "lucide-react";
import { BoardJob } from "../../lib/jobFilters";
import { useJobSelection } from "../feedSelection";
import { relativeDate } from "@/features/jobs/lib/smartFeedUtils";
import { Distance } from "./chips";
import { CardActionsContext } from "./context";
import { CardMeta, CardTitle } from "./parts";
import { Gauge } from "./gauge";
import { CardFooter, CardShell, SalaryLine } from "./shell";
// ── compact card ────────────────────────────────────────────────────────

export function JobCard({ job, currentTab, refSetter, excludeKeywords }: { job: BoardJob; currentTab: string; refSetter: (el: HTMLDivElement | null) => void; excludeKeywords?: string }) {
  return (
    <CardShell job={job} currentTab={currentTab} refSetter={refSetter} excludeKeywords={excludeKeywords}>
      {/* Demo `.spot-top`: title/meta/salary share one column (`.spot-main`)
          beside the gauge, so the row's height comes from that whole stacked
          block — not from the gauge alone. Putting the gauge next to the
          title line ONLY (its previous shape here) made the row as tall as
          the 74px gauge while the title text filled a fraction of that,
          leaving a dead gap above the meta line that isn't in the demo. */}
      <div className="flex flex-col">
        <div className="flex items-start gap-[14px]">
          <div className="flex-1 min-w-0">
            <div className="flex items-start gap-[10px]">
              <CardTitle job={job} />
              <CardActionsContext.Consumer>
                {({ onToggleStar, starred }) => (
                  <button
                    type="button"
                    onClick={onToggleStar}
                    title={starred ? "Remove from favourites" : "Add to favourites"}
                    aria-label={starred ? "Remove from favourites" : "Add to favourites"}
                    className="shrink-0 hover:opacity-80 transition-opacity mt-0.5"
                    style={{ background: "none", border: "none", cursor: "pointer", color: starred ? "var(--warning)" : "var(--text-3)", fontSize: 18, lineHeight: 1, padding: 0 }}
                  >
                    <Star
                      style={{ width: 18, height: 18 }}
                      fill={starred ? "currentColor" : "none"}
                      strokeWidth={starred ? 0 : 1.5}
                    />
                  </button>
                )}
              </CardActionsContext.Consumer>
            </div>
            <CardMeta job={job} compact />
            <SalaryLine job={job} />
          </div>
          <Gauge job={job} />
        </div>
        <CardFooter job={job} />
      </div>
    </CardShell>
  );
}

// ── flat row (Applied / Favourite) ─────────────────────────────────────
//
// A single compact row rather than the full board card — this list has no
// split-pane detail beside it (see SmartFeed's "wide" mode), so there's no
// need to repeat chips/actions that only make sense next to that pane.
// `showAppliedDate` is only true on the Applied tab — Favourite jobs may or
// may not be applied, so the date would be misleading noise there.
export function AppliedRow({ job, showAppliedDate }: { job: BoardJob; showAppliedDate?: boolean }) {
  const selection = useJobSelection();
  const postedRel  = relativeDate(job.posted_at || job.created_at);
  const appliedRel = job.applied_at ? relativeDate(job.applied_at) : null;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => selection?.onOpenDetail?.(job.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          selection?.onOpenDetail?.(job.id);
        }
      }}
      className="flex items-center gap-3 px-4 py-3.5 bg-surface border border-border rounded-lg cursor-pointer hover:shadow-[var(--shadow-card-hover)] transition-shadow"
    >
      <ChevronRight className="w-4 h-4 text-text-3 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="font-semibold text-text text-[15px] leading-snug truncate">{job.title}</p>
        <p className="text-label text-text-2 mt-0.5 truncate">
          {job.company}
          {job.location && <> · {job.location}</>}
          {job.profile_name && <> · via {job.profile_name}</>}
        </p>
        <p className="text-caption text-text-3 mt-0.5">
          {typeof job.distance_km === "number" && (
            <><Distance km={job.distance_km} method={job.distance_method ?? null} /> · </>
          )}
          {postedRel && <>Posted {postedRel.toLowerCase()}</>}
          {showAppliedDate && appliedRel && <> · Applied {appliedRel.toLowerCase()}</>}
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0" onClick={(e) => e.stopPropagation()}>
        <Gauge job={job} compact />
        <a
          href={job.url}
          target="_blank"
          rel="noopener noreferrer"
          title="View job posting"
          aria-label="View job posting"
          className="p-1.5 rounded hover:bg-[var(--surface-2)] text-text-3 hover:text-text transition-colors"
        >
          <ExternalLink className="w-4 h-4" />
        </a>
      </div>
    </div>
  );
}

export function EmptyState({ favourite = false }: { favourite?: boolean }) {
  return (
    <div className="bg-surface border border-border rounded-md">
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <div className="w-12 h-12 rounded-lg bg-[var(--surface-2)] border border-border flex items-center justify-center mb-4">
          {favourite
            ? <Star className="w-5 h-5 text-text-3" />
            : <Inbox className="w-5 h-5 text-text-3" />}
        </div>
        {favourite ? (
          <>
            <p className="text-title font-semibold text-text mb-1">No favourite jobs</p>
            <p className="text-label text-text-2">Star a job to shortlist it here.</p>
          </>
        ) : (
          <>
            <p className="text-title font-semibold text-text mb-1">No jobs match your filters</p>
            <p className="text-label text-text-2">Adjust the filters above or run the pipeline to fetch new listings.</p>
          </>
        )}
      </div>
    </div>
  );
}

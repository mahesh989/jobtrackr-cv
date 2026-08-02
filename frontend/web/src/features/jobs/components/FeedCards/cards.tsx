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
import { getAtsMeta, relativeDate } from "@/features/jobs/lib/smartFeedUtils";
import { CardChips, Distance, MatchBar } from "./chips";
import { CardActionsContext } from "./context";
import { CardActions, CardMeta, CardTitle } from "./parts";
import { CardFooter, CardShell, SalaryLine } from "./shell";
export function HeroCard({ job, currentTab, refSetter, excludeKeywords }: { job: BoardJob; currentTab: string; refSetter: (el: HTMLDivElement | null) => void; excludeKeywords?: string }) {
  return (
    <CardShell job={job} currentTab={currentTab} refSetter={refSetter} hero excludeKeywords={excludeKeywords}>
      <CardChips job={job} />
      <CardTitle job={job} />
      <CardMeta job={job} />
      <div className="mt-2"><MatchBar job={job} /></div>
      <CardActions job={job} />
    </CardShell>
  );
}

// ── compact card ────────────────────────────────────────────────────────

export function JobCard({ job, currentTab, refSetter, excludeKeywords }: { job: BoardJob; currentTab: string; refSetter: (el: HTMLDivElement | null) => void; excludeKeywords?: string }) {
  return (
    <CardShell job={job} currentTab={currentTab} refSetter={refSetter} excludeKeywords={excludeKeywords}>
      <div className="flex flex-col" style={{ gap: 9 }}>
        <div className="flex items-start gap-2.5">
          <CardTitle job={job} />
          <CardActionsContext.Consumer>
            {({ onToggleStar, starred }) => (
              <button
                type="button"
                onClick={onToggleStar}
                title={starred ? "Remove from favourites" : "Add to favourites"}
                className="shrink-0 hover:opacity-80 transition-opacity mt-0.5"
                style={{ background: "none", border: "none", cursor: "pointer", color: starred ? "#d97706" : "#d1d5db", fontSize: 17, lineHeight: 1, padding: 0 }}
              >
                <Star
                  style={{ width: 17, height: 17 }}
                  fill={starred ? "currentColor" : "none"}
                  strokeWidth={starred ? 0 : 1.5}
                />
              </button>
            )}
          </CardActionsContext.Consumer>
        </div>
        <CardMeta job={job} compact />
        <SalaryLine job={job} />
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
  const score = job.tailored_match_score ?? job.initial_ats_score ?? null;
  const meta = getAtsMeta(job);
  const postedRel  = relativeDate(job.posted_at || job.created_at);
  const appliedRel = job.applied_at ? relativeDate(job.applied_at) : null;

  return (
    <div
      onClick={() => selection?.onOpenDetail?.(job.id)}
      className="flex items-center gap-3 px-4 py-3.5 bg-surface border border-border rounded-lg cursor-pointer hover:shadow-[0_2px_10px_rgba(16,24,40,0.07)] transition-shadow"
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
      {score != null && (
        <div className="flex items-center gap-2 shrink-0" onClick={(e) => e.stopPropagation()}>
          <div className="text-right leading-none">
            <p className="text-micro font-semibold text-text-3 uppercase tracking-wide">Tailored</p>
            <p className="mt-1 tabular-nums">
              <span className={`text-[20px] font-bold ${meta.chipText}`}>{score}</span>
              <span className="text-label font-medium text-text-3">/100</span>
            </p>
          </div>
          <a
            href={job.url}
            target="_blank"
            rel="noopener noreferrer"
            title="View job posting"
            className="p-1.5 rounded hover:bg-[var(--surface-2)] text-text-3 hover:text-text transition-colors"
          >
            <ExternalLink className="w-4 h-4" />
          </a>
        </div>
      )}
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

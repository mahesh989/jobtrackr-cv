"use client";

/**
 * Card sub-sections — title, meta line and the action row.
 *
 * Split out of the former single-file FeedCards.tsx (839 lines). Pure code
 * motion — component bodies and ordering are unchanged. Every component is
 * still importable from "./FeedCards".
 * 
 */
import { useContext } from "react";
import { Star } from "lucide-react";
import { AnalyzeJobButton, FullAnalysisButton } from "@/features/cv/analysis/AnalyzeJobButton";
import { BoardJob } from "../../lib/jobFilters";
import { relativeDate } from "@/features/jobs/lib/smartFeedUtils";
import { CardMenu } from "../CardMenu";
import { Distance, ProgressDots } from "./chips";
import { CardActionsContext } from "./context";
export function CardTitle({ job, inline }: { job: BoardJob; inline?: boolean }) {
  const link = (
    <a
      href={job.url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      // `inline` deliberately: as a block/flex-1 element the anchor stretched
      // across the whole card row, so clicking the empty space beside a short
      // title opened the job posting. Keeping it inline confines the hit area
      // to the words themselves — everywhere else on the card selects the job
      // into the detail pane instead.
      className="inline font-semibold text-text hover:text-[var(--brand)] leading-snug break-words"
      style={!inline ? { fontSize: 16, lineHeight: 1.4 } : undefined}
    >
      {job.title}
    </a>
  );
  // The card layout still needs the flex child to claim the row's free space;
  // only the anchor inside it shrinks to the text.
  return inline ? link : <span className="block flex-1 min-w-0">{link}</span>;
}

export function CardMeta({ job, compact }: { job: BoardJob; compact?: boolean }) {
  const postedRel = relativeDate(job.posted_at);
  const addedRel  = relativeDate(job.created_at);
  return (
    <p className={`${compact ? "mt-[3px]" : ""} text-[13px] text-text-2`}>
      {job.company && <span className="font-medium">{job.company}</span>}
      {job.company && job.location && <span className="text-text-3"> · </span>}
      {job.location && <span>{job.location}</span>}
      {typeof job.distance_km === "number" && (
        <>
          <span className="text-text-3"> · </span>
          <Distance km={job.distance_km} method={job.distance_method ?? null} />
        </>
      )}
      {postedRel && (
        <>
          <span className="text-text-3"> · </span>
          {/* relativeDate() reads Date.now() — the bucket it lands in ("8
              hours ago" vs "9 hours ago") can differ between the server
              render and the moment the client hydrates, whenever that gap
              straddles a boundary. That's expected drift for a live
              relative-time string, not a real mismatch — suppress the
              warning rather than forcing a client-side re-render to "fix"
              text that's correct on both sides. */}
          <span
            suppressHydrationWarning
            title={`Posted ${new Date(job.posted_at as string).toLocaleDateString("en-AU", {day: "2-digit", month: "2-digit", year: "numeric"})}`}
          >
            Posted {postedRel.toLowerCase()}
          </span>
        </>
      )}
      {!postedRel && addedRel && (
        <>
          <span className="text-text-3"> · </span>
          <span
            suppressHydrationWarning
            title={`Added ${new Date(job.created_at as string).toLocaleDateString("en-AU", {day: "2-digit", month: "2-digit", year: "numeric"})}`}
          >
            Added {addedRel.toLowerCase()}
          </span>
        </>
      )}
    </p>
  );
}

export function CardActions({ job, compact }: { job: BoardJob; compact?: boolean }) {
  const { onDismiss, onEdit, onToggleStar, starred, pending } = useContext(CardActionsContext);
  return (
    <div
      className={`flex items-center gap-2 shrink-0 ${compact ? "" : "mt-2 justify-between"}`}
      onClick={(e) => e.stopPropagation()}
    >
      {!compact && <ProgressDots progress={job.progress} />}
      <div className="flex items-center gap-1.5">
        {compact && <ProgressDots progress={job.progress} />}
        <button
          type="button"
          onClick={onToggleStar}
          title={starred ? "Remove from favourites" : "Add to favourites"}
          aria-label={starred ? "Remove from favourites" : "Add to favourites"}
          className="p-1 rounded hover:bg-[var(--surface-2)] transition-colors"
        >
          <Star
            className={`w-[15px] h-[15px] transition-colors ${starred ? "text-warning fill-warning" : "text-text-3"}`}
            strokeWidth={starred ? 0 : 1.5}
          />
        </button>
        {job.progress.latest_run_id ? (
          <FullAnalysisButton
            jobId={job.id}
            analysisHref={`/jobs/${job.id}/analyze/${job.progress.latest_run_id}`}
          />
        ) : job.applied_at ? (
          <button
            disabled
            className="flex items-center gap-1.5 rounded-md bg-[var(--surface-2)] border border-border px-2.5 py-1 text-xs font-medium text-text-3 cursor-not-allowed"
            title="This job was manually marked as applied and has no analysis run."
          >
            No Analysis
          </button>
        ) : (
          <AnalyzeJobButton jobId={job.id} hasAnalysis={job.progress.has_analysis} />
        )}
        <CardMenu
          job={job}
          onDismiss={onDismiss}
          onEdit={onEdit}
          pending={pending}
        />
      </div>
    </div>
  );
}

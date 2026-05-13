"use client";

import { useTransition } from "react";
import { markJobApplied, markJobDismissed } from "@/lib/actions";

interface Job {
  id: string;
  profile_id: string;
  url: string;
  title: string;
  company: string;
  location: string;
  source: string;
  source_tier: number;
  posted_at: string | null;
  created_at: string;
  visa_likelihood: number | null;
  keywords_matched: string[];
  applied_at: string | null;
  dismissed_at: string | null;
  is_dead_link: boolean;
  dedup_status: string;
}

function ScoreBadge({ value, label }: { value: number | null; label: string }) {
  if (value === null) return null;
  const pct = Math.round(value * 100);
  const color = value >= 0.7 ? "text-green-700 bg-green-50 border-green-200"
              : value >= 0.4 ? "text-amber-700 bg-amber-50 border-amber-200"
                             : "text-slate bg-bone border-dust";
  return (
    <span className={`text-sm px-3 py-1 rounded-pill border font-medium ${color}`}>
      {label} {pct}%
    </span>
  );
}

function sourceColor(source: string) {
  const colors: Record<string, string> = {
    adzuna: "bg-blue-50 text-blue-700",
    greenhouse: "bg-violet-50 text-violet-700",
    lever: "bg-pink-50 text-pink-700",
    pageup: "bg-orange-50 text-orange-700",
  };
  return colors[source] ?? "bg-bone text-slate";
}

export function JobCard({ job }: { job: Job }) {
  const [pending, startTransition] = useTransition();

  const applied   = !!job.applied_at;
  const dismissed = !!job.dismissed_at;

  const actionButtons = (
    <div className="flex gap-2">
      <button
        disabled={pending || applied}
        onClick={() => startTransition(() => markJobApplied(job.id, job.profile_id))}
        className={`text-sm px-5 py-1.5 rounded-button font-medium border-[1.5px] transition-transform active:scale-[0.98] ${
          applied
            ? "bg-green-50 text-green-700 border-green-300 cursor-default"
            : "bg-white hover:bg-bone text-slate hover:text-charcoal border-dust hover:border-slate"
        }`}
      >
        {applied ? "Applied ✓" : "Applied"}
      </button>
      <button
        disabled={pending || dismissed}
        onClick={() => startTransition(() => markJobDismissed(job.id, job.profile_id))}
        className="text-sm px-3 py-1.5 rounded-button bg-white hover:bg-bone border-[1.5px] border-dust text-charcoal font-medium transition-colors disabled:opacity-40"
      >
        ✕
      </button>
    </div>
  );

  return (
    <div className={`bg-white border rounded-stadium p-5 sm:p-6 transition-opacity shadow-[0_4px_12px_rgba(0,0,0,0.02)] ${
      dismissed ? "opacity-50 border-dust" : "border-dust hover:border-slate"
    }`}>
      {/* Desktop layout: title+meta left, date+actions right */}
      <div className="flex items-start justify-between gap-4">
        {/* Left: title + meta */}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <a
              href={job.url}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-ink hover:text-link transition-colors leading-snug text-lg"
            >
              {job.title}
            </a>
            {job.is_dead_link && (
              <span className="text-sm px-3 py-1 rounded-pill bg-signal text-white border border-signal font-medium">
                dead link
              </span>
            )}
            {job.dedup_status === "repost" && (
              <span className="text-sm px-3 py-1 rounded-pill bg-amber-50 text-amber-700 border border-amber-200 font-medium">
                repost
              </span>
            )}
          </div>

          <p className="text-charcoal text-base">
            {job.company}
            {job.location ? ` · ${job.location}` : ""}
          </p>

          {/* Scores + source */}
          <div className="flex flex-wrap items-center gap-2 mt-3">
            <span className={`text-sm px-3 py-1 rounded-pill font-medium ${sourceColor(job.source)}`}>
              {job.source}
            </span>
            <ScoreBadge value={job.visa_likelihood} label="Visa" />
            {job.keywords_matched.length > 0 && (
              <span className="text-sm text-slate">
                matched: {job.keywords_matched.slice(0, 3).join(", ")}
                {job.keywords_matched.length > 3 ? ` +${job.keywords_matched.length - 3}` : ""}
              </span>
            )}
          </div>
        </div>

        {/* Right: date + actions — desktop only */}
        <div className="hidden sm:flex flex-col items-end gap-3 shrink-0">
          <div className="flex flex-col items-end text-sm text-slate mb-1">
            <span>Fetched {new Date(job.created_at).toLocaleDateString("en-AU", { day: "numeric", month: "short" })}</span>
            {job.posted_at && (
              <span>Posted {new Date(job.posted_at).toLocaleDateString("en-AU", { day: "numeric", month: "short" })}</span>
            )}
          </div>
          {actionButtons}
        </div>
      </div>

      {/* Mobile: date + actions below content */}
      <div className="flex sm:hidden items-center justify-between mt-4 gap-2">
        <div className="flex flex-col text-sm text-slate">
          <span>Fetched {new Date(job.created_at).toLocaleDateString("en-AU", { day: "numeric", month: "short" })}</span>
          {job.posted_at && (
            <span>Posted {new Date(job.posted_at).toLocaleDateString("en-AU", { day: "numeric", month: "short" })}</span>
          )}
        </div>
        {actionButtons}
      </div>
    </div>
  );
}


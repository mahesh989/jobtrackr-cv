"use client";

import { useState } from "react";
import { Badge, Button } from "@/components/ui";
import { getSavedJobsForRun } from "@/lib/actions";

type SavedJob = Awaited<ReturnType<typeof getSavedJobsForRun>>[number];

export function RunJobsTable({
  profileId, startedAt, finishedAt, jobsSaved,
}: {
  profileId: string;
  startedAt: string;
  finishedAt: string | null;
  jobsSaved: number;
}) {
  const [isOpen, setIsOpen]   = useState(false);
  const [jobs, setJobs]       = useState<SavedJob[] | null>(null);
  const [loading, setLoading] = useState(false);

  if (jobsSaved === 0) return null;

  async function handleToggle() {
    if (!isOpen && !jobs) {
      setLoading(true);
      const data = await getSavedJobsForRun(profileId, startedAt, finishedAt);
      setJobs(data);
      setLoading(false);
    }
    setIsOpen(!isOpen);
  }

  return (
    <div className="mt-3 pt-3 border-t border-[var(--border)]">
      <Button
        onClick={handleToggle}
        className="text-[12px] text-[var(--brand)] hover:text-[#0550AE] font-medium flex items-center gap-1.5 transition-colors"
      >
        <svg
          className={`w-3 h-3 transition-transform duration-150 ${isOpen ? "rotate-90" : ""}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7"/>
        </svg>
        {isOpen ? "Hide jobs" : `View ${jobsSaved} saved job${jobsSaved === 1 ? "" : "s"}`}
      </Button>

      {isOpen && (
        <div className="mt-3 space-y-2">
          {loading ? (
            <p className="text-[12px] text-text-2 py-2">Loading…</p>
          ) : (
            (jobs || []).map((job, i) => (
              <div key={i} className="bg-surface border border-[var(--border)] rounded-md px-4 py-3">
                <a
                  href={job.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[13px] font-semibold text-text hover:text-[var(--brand)] transition-colors block truncate"
                >
                  {job.title}
                </a>
                <p className="text-[11px] text-text-2 mt-0.5 truncate">
                  {job.company}{job.location ? ` · ${job.location}` : ""}
                </p>
                {((job.keywords_matched?.length ?? 0) > 0 || job.visa_likelihood !== null) && (
                  <div className="flex flex-wrap items-center gap-1.5 mt-2">
                    {job.keywords_matched?.map((kw: string) => (
                      <Badge key={kw} variant="gray" className="text-[10px] px-1.5 h-4">{kw}</Badge>
                    ))}
                    {job.sponsorship_status === "yes" && (
                      <Badge variant="green" className="text-[10px] px-1.5 h-4">✓ Sponsored</Badge>
                    )}
                    {job.sponsorship_status === "no" && (
                      <Badge variant="red" className="text-[10px] px-1.5 h-4">✗ No sponsor</Badge>
                    )}
                    {job.citizen_pr_only === true && (
                      <Badge variant="amber" className="text-[10px] px-1.5 h-4">PR/Citizen only</Badge>
                    )}
                    {(!job.sponsorship_status || job.sponsorship_status === "not_mentioned") && job.citizen_pr_only !== true && (
                      <Badge variant="gray" className="text-[10px] px-1.5 h-4">? Check JD</Badge>
                    )}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

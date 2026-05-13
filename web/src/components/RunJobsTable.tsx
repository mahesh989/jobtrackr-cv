"use client";

import { useState } from "react";
import { getSavedJobsForRun } from "@/lib/actions";

export function RunJobsTable({
  profileId, startedAt, finishedAt, jobsSaved,
}: {
  profileId: string;
  startedAt: string;
  finishedAt: string | null;
  jobsSaved: number;
}) {
  const [isOpen, setIsOpen]   = useState(false);
  const [jobs, setJobs]       = useState<any[] | null>(null);
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
    <div className="mt-3 pt-3 border-t border-[#D0D7DE]">
      <button
        onClick={handleToggle}
        className="text-[12px] text-[#0969DA] hover:text-[#0550AE] font-medium flex items-center gap-1.5 transition-colors"
      >
        <svg
          className={`w-3 h-3 transition-transform duration-150 ${isOpen ? "rotate-90" : ""}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7"/>
        </svg>
        {isOpen ? "Hide jobs" : `View ${jobsSaved} saved job${jobsSaved === 1 ? "" : "s"}`}
      </button>

      {isOpen && (
        <div className="mt-3 space-y-2">
          {loading ? (
            <p className="text-[12px] text-[#656D76] py-2">Loading…</p>
          ) : (
            (jobs || []).map((job, i) => (
              <div key={i} className="bg-white border border-[#D0D7DE] rounded-md px-4 py-3">
                <a
                  href={job.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[13px] font-semibold text-[#1F2328] hover:text-[#0969DA] transition-colors block truncate"
                >
                  {job.title}
                </a>
                <p className="text-[11px] text-[#656D76] mt-0.5 truncate">
                  {job.company}{job.location ? ` · ${job.location}` : ""}
                </p>
                {((job.keywords_matched?.length ?? 0) > 0 || job.visa_likelihood !== null) && (
                  <div className="flex flex-wrap items-center gap-1.5 mt-2">
                    {job.keywords_matched?.map((kw: string) => (
                      <span key={kw} className="badge badge-gray text-[10px] px-1.5 h-4">{kw}</span>
                    ))}
                    {job.sponsorship_status === "yes" && (
                      <span className="badge badge-green text-[10px] px-1.5 h-4">✓ Sponsored</span>
                    )}
                    {job.sponsorship_status === "no" && (
                      <span className="badge badge-red text-[10px] px-1.5 h-4">✗ No sponsor</span>
                    )}
                    {job.citizen_pr_only === true && (
                      <span className="badge badge-amber text-[10px] px-1.5 h-4">PR/Citizen only</span>
                    )}
                    {(!job.sponsorship_status || job.sponsorship_status === "not_mentioned") && job.citizen_pr_only !== true && (
                      <span className="badge badge-gray text-[10px] px-1.5 h-4">? Check JD</span>
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

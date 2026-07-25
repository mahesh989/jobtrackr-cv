"use client";

/**
 * Right-hand (or mobile full-screen) detail pane for the job board's
 * master-detail layout. Fetches the lean per-job payload on selection and
 * renders only the tabs that have real content for THIS job's state:
 *
 *   always            → Job description
 *   has a run w/ score → Match & score
 *   has tailored CV    → Tailored CV
 *   has cover letter   → Cover letter
 *   has CV or letter   → More (downloads + email)
 *
 * Not-analysed / needs-JD / failed jobs show Job description only — no
 * empty tabs pretending data exists when it doesn't.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, X } from "lucide-react";
import { Tabs } from "@/components/ui";
import { useBoardDetail } from "../../lib/useBoardDetail";
import type { BoardJob } from "../../lib/jobFilters";
import { DetailHeader } from "./DetailHeader";
import { JobDescriptionTab } from "./JobDescriptionTab";
import { MatchScoreTab } from "./MatchScoreTab";
import { TailoredCvTab } from "./TailoredCvTab";
import { CoverLetterTab } from "./CoverLetterTab";
import { MoreTab } from "./MoreTab";

/**
 * Keyed by job.id at the call site below — remounting on job change is what
 * resets the "jd" tab default (rather than a setState-in-effect, which the
 * lint config flags as a cascading-render smell).
 */
function BoardDetailPanelInner({
  job, onClose, mobile,
}: {
  job: BoardJob;
  onClose: () => void;
  mobile: boolean;
}) {
  const router = useRouter();
  const { data, loading, error } = useBoardDetail(job.id);
  const [tab, setTab] = useState("jd");

  function refresh() {
    router.refresh();
  }

  const run = data?.run ?? null;
  const hasScore  = run?.match_score != null;
  const hasCv     = !!run?.tailored_cv_storage_path;
  const hasLetter = !!data?.cover_letter?.pass_3_final;
  const hasMore   = hasCv || hasLetter;

  return (
    <div className={mobile ? "fixed inset-0 z-40 bg-surface flex flex-col" : "flex flex-col h-full overflow-hidden"}>
      {mobile && (
        <div className="flex items-center justify-between px-4 py-2 border-b border-border shrink-0">
          <button type="button" onClick={onClose} className="inline-flex items-center gap-1.5 text-label text-text-2 hover:text-text">
            <X className="w-4 h-4" /> Back to list
          </button>
        </div>
      )}

      <DetailHeader job={job} onClosed={onClose} onChanged={refresh} />

      {loading ? (
        <div className="flex-1 flex items-center justify-center text-text-3">
          <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…
        </div>
      ) : error ? (
        <div className="flex-1 flex items-center justify-center px-6">
          <p className="text-label text-red-600">{error}</p>
        </div>
      ) : (
        <Tabs.Root value={tab} onValueChange={setTab} className="flex flex-col flex-1 min-h-0">
          <Tabs.List className="flex items-center gap-1 border-b border-border px-8 shrink-0 mt-3.5 bg-[#fafbfc]">
            <Tabs.Trigger value="jd" className="text-[13.5px] font-semibold px-[14px] py-[10px]">Job description</Tabs.Trigger>
            {hasScore && <Tabs.Trigger value="match" className="text-[13.5px] font-semibold px-[14px] py-[10px]">Match &amp; score</Tabs.Trigger>}
            {hasCv && <Tabs.Trigger value="cv" className="text-[13.5px] font-semibold px-[14px] py-[10px]">Tailored CV</Tabs.Trigger>}
            {hasLetter && <Tabs.Trigger value="cover" className="text-[13.5px] font-semibold px-[14px] py-[10px]">Cover letter</Tabs.Trigger>}
            {hasMore && <Tabs.Trigger value="more" className="text-[13.5px] font-semibold px-[14px] py-[10px]">More</Tabs.Trigger>}
          </Tabs.List>

          <div className="flex-1 min-h-0 overflow-y-auto px-8 py-5 pb-9 text-[14.5px] leading-relaxed" style={{ maxWidth: 860 }}>
            <Tabs.Content value="jd"><JobDescriptionTab job={job} detail={data} /></Tabs.Content>
            {hasScore && (
              <Tabs.Content value="match"><MatchScoreTab job={job} detail={data} /></Tabs.Content>
            )}
            {hasCv && run && (
              <Tabs.Content value="cv"><TailoredCvTab run={run} /></Tabs.Content>
            )}
            {hasLetter && data?.cover_letter && (
              <Tabs.Content value="cover"><CoverLetterTab jobId={job.id} letter={data.cover_letter} /></Tabs.Content>
            )}
            {hasMore && run && (
              <Tabs.Content value="more"><MoreTab job={job} run={run} letter={data?.cover_letter ?? null} /></Tabs.Content>
            )}
          </div>
        </Tabs.Root>
      )}
    </div>
  );
}

export function BoardDetailPanel({
  job, onClose, mobile = false,
}: {
  job: BoardJob;
  onClose: () => void;
  /** Renders as a full-screen overlay with a back button (mobile drawer). */
  mobile?: boolean;
}) {
  return <BoardDetailPanelInner key={job.id} job={job} onClose={onClose} mobile={mobile} />;
}

export function EmptyDetail() {
  return (
    <div className="hidden lg:flex flex-col items-center justify-center h-full text-center px-6">
      <p className="text-title font-semibold text-text mb-1">Select a job</p>
      <p className="text-label text-text-3">Click a job on the left to see its details here.</p>
    </div>
  );
}

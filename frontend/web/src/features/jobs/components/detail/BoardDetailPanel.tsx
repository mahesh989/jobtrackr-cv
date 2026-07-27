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
import { Loader2, X } from "lucide-react";
import { Tabs } from "@/components/ui";
import { useBoardDetail } from "../../lib/useBoardDetail";
import { useIsDesktop } from "../../lib/useIsDesktop";
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
  // Only the pane the viewport actually shows does the data work; its
  // off-screen twin stays inert (see useIsDesktop).
  const isDesktop = useIsDesktop();
  const active = mobile ? !isDesktop : isDesktop;
  // Re-pull this pane's own payload so a finished run's new score, tabs and
  // tailored CV appear straight away. router.refresh() is deliberately NOT
  // called: re-rendering the whole dashboard is what reset the board's scroll
  // position to the top, and the pane is the only thing that needs new data —
  // the left card's chip catches up on the next natural navigation.
  const [reloadToken, setReloadToken] = useState(0);
  function refresh() {
    setReloadToken((n) => n + 1);
  }

  const { data, loading, error } = useBoardDetail(job.id, active, reloadToken);
  const [tab, setTab] = useState("jd");

  const run = data?.run ?? null;
  // Which tabs exist is decided from the board's own progress flags, which are
  // already in memory, rather than from the fetched payload. Waiting for the
  // fetch meant the whole pane sat on a spinner for every selection even though
  // the answer was known up front; now the shell and the Job description tab
  // paint immediately and only the data-backed tab bodies fill in.
  // Once the payload lands it wins, so a stale flag self-corrects.
  const hasScore  = data ? run?.match_score != null           : job.progress.has_analysis;
  const hasCv     = data ? !!run?.tailored_cv_storage_path    : job.progress.has_tailored_cv;
  const hasLetter = data ? !!data.cover_letter?.pass_3_final  : job.progress.has_cover_letter;
  const hasMore   = hasCv || hasLetter;

  const pending = (
    <div className="flex items-center gap-2 py-6 text-label text-text-3">
      <Loader2 className="w-4 h-4 animate-spin" /> Loading…
    </div>
  );

  return (
    <div className={mobile ? "fixed inset-0 z-40 bg-surface flex flex-col" : "flex flex-col h-full overflow-hidden"}>
      {mobile && (
        <div className="flex items-center justify-between px-4 py-2 border-b border-border shrink-0">
          <button type="button" onClick={onClose} className="inline-flex items-center gap-1.5 text-label text-text-2 hover:text-text">
            <X className="w-4 h-4" /> Back to list
          </button>
        </div>
      )}

      <DetailHeader
        job={job}
        description={data?.description ?? null}
        manualJdText={data?.manual_jd_text ?? null}
        detailLoaded={!!data}
        letterId={data?.cover_letter?.pass_3_final ? data.cover_letter.id : null}
        onClosed={onClose}
        onChanged={refresh}
        mobile={mobile}
      />

      {error ? (
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
            <Tabs.Content value="jd"><JobDescriptionTab job={job} detail={data} loading={loading} /></Tabs.Content>
            {hasScore && (
              <Tabs.Content value="match">
                {loading ? pending : <MatchScoreTab job={job} detail={data} />}
              </Tabs.Content>
            )}
            {hasCv && (
              <Tabs.Content value="cv">
                {run ? <TailoredCvTab run={run} /> : pending}
              </Tabs.Content>
            )}
            {hasLetter && (
              <Tabs.Content value="cover">
                {data?.cover_letter
                  ? <CoverLetterTab jobId={job.id} letter={data.cover_letter} />
                  : pending}
              </Tabs.Content>
            )}
            {hasMore && (
              <Tabs.Content value="more">
                {run ? <MoreTab job={job} run={run} letter={data?.cover_letter ?? null} /> : pending}
              </Tabs.Content>
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

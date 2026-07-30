"use client";

/**
 * Right-hand (or mobile full-screen) detail pane for the job board's
 * master-detail layout. Fetches the lean per-job payload on selection and
 * renders only the tabs that have real content for THIS job's state:
 *
 *   always            → Job description
 *   has a run w/ score → Match & score
 *   has tailored CV    → Tailored CV
 *   has cover letter   → Cover letter  (letter + message, both editable)
 *
 * Not-analysed / needs-JD / failed jobs show Job description only — no
 * empty tabs pretending data exists when it doesn't.
 *
 * There used to be a fifth "More" tab holding downloads and a second copy of
 * the email draft. Downloads moved to the header (they're an action on the
 * job, not something you read) and the draft moved into the Cover letter tab
 * next to the letter it belongs with — that copy was also the one that threw
 * the user's edits away on send.
 */

import { useEffect, useRef, useState } from "react";
import { Loader2, X, ChevronUp } from "lucide-react";
import { Tabs } from "@/components/ui";
import { useBoardDetail } from "../../lib/useBoardDetail";
import { useIsDesktop } from "../../lib/useIsDesktop";
import { deriveProgress } from "../../lib/progressFlags";
import { derivePipelineState, recomputeGates } from "../../lib/pipelineState";
import type { BoardJob } from "../../lib/jobFilters";
import { DetailHeader } from "./DetailHeader";
import { JobDescriptionTab } from "./JobDescriptionTab";
import { MatchScoreTab } from "./MatchScoreTab";
import { TailoredCvTab } from "./TailoredCvTab";
import { CoverLetterTab } from "./CoverLetterTab";

/**
 * Keyed by job.id at the call site below — remounting on job change is what
 * resets the "jd" tab default (rather than a setState-in-effect, which the
 * lint config flags as a cascading-render smell).
 */
function BoardDetailPanelInner({
  job, onClose, onPatchJob, mobile, inline,
}: {
  job: BoardJob;
  onClose: () => void;
  /** Optimistically patch this job's row in the board list. The pane refreshes
   *  its own payload rather than calling router.refresh() (which resets the
   *  board's scroll), so without this the card on the left keeps showing
   *  "Ready to apply" after the popup has just confirmed the application. */
  onPatchJob?: (id: string, patch: Partial<BoardJob>) => void;
  mobile: boolean;
  /** Accordion mode: the flat Applied/Favourite list expands a job in place
   *  (full width, natural height, no internal scroll) instead of opening a
   *  split-pane detail — the page itself scrolls, so the other rows stay
   *  reachable above and below. A small "Collapse" bar replaces the mobile
   *  drawer's "Back to list". */
  inline?: boolean;
}) {
  // Only the pane the viewport actually shows does the data work; its
  // off-screen twin stays inert (see useIsDesktop). `inline` mounts a single
  // instance per expanded row rather than a desktop+mobile pair, so it's
  // always the active one.
  const isDesktop = useIsDesktop();
  const active = inline ? true : (mobile ? !isDesktop : isDesktop);
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

  // A tab whose condition flips false while it is the selected one leaves the
  // body area blank: its Trigger unregisters but `tab` still points at it and
  // every Content returns null. Fall back to the one tab that always exists.
  // Reachable whenever a stale progress flag self-corrects once the payload
  // lands — and for anyone whose last selection was the now-deleted More tab.
  const tabExists =
    tab === "jd" ||
    (tab === "match" && hasScore) ||
    (tab === "cv" && hasCv) ||
    (tab === "cover" && hasLetter);
  const activeTab = tabExists ? tab : "jd";

  // Push a finished run back onto the board's own copy of this row.
  //
  // The pane learns a run finished over Realtime and refetches its payload, so
  // its tabs and header update in place — but the card on the left is rendered
  // from the server's `jobs` array, which nothing refreshes until a genuine
  // navigation. That is why an analysis could complete, the tabs appear, and
  // the card underneath still read "Analyse" until a manual reload.
  //
  // Both derivations are the same pure functions the server page uses, so the
  // patched row is what the next real fetch would have produced anyway.
  const syncedKey = useRef<string | null>(null);
  useEffect(() => {
    if (!onPatchJob || !data?.run) return;
    const r = data.run;
    const letterDone = !!data.cover_letter?.pass_3_final;

    // Already agrees — nothing to patch, and recording the key stops this from
    // re-running on every unrelated render.
    const boardIsCurrent =
      job.progress.latest_run_id === r.id &&
      job.progress.latest_run_status === r.status &&
      job.progress.has_cover_letter === letterDone;

    const key = `${r.id}:${r.status}:${letterDone}`;
    if (boardIsCurrent || syncedKey.current === key) {
      syncedKey.current = key;
      return;
    }
    syncedKey.current = key;

    const runRef = {
      id:                        r.id,
      job_id:                    job.id,
      status:                    r.status,
      tailored_pdf_storage_path: null,
      tailored_cv_storage_path:  r.tailored_cv_storage_path,
      completed_at:              r.status === "completed" ? r.created_at : null,
      created_at:                r.created_at,
    };
    const letterRef = data.cover_letter
      ? {
          id:           data.cover_letter.id,
          job_id:       job.id,
          status:       letterDone ? "completed" : data.cover_letter.status,
          completed_at: null,
          created_at:   r.created_at,
        }
      : undefined;

    const th    = job.atsThresholds ?? { initial: 60, final: 70 };
    const gates = recomputeGates(r.match_score, r.tailored_match_score, th.initial, th.final);

    onPatchJob(job.id, {
      progress: deriveProgress({ applied_at: job.applied_at }, runRef, letterRef),
      initial_ats_score:    r.match_score ?? job.initial_ats_score,
      tailored_match_score: r.tailored_match_score ?? job.tailored_match_score,
      pipelineState: derivePipelineState({
        job: {
          applied_at:   job.applied_at,
          dismissed_at: job.dismissed_at,
          has_email:    job.has_email ?? null,
          // Fresh, not the stale board-list prop: a job that just had its thin
          // JD filled in and analysed successfully was still carrying
          // jd_quality: "thin" from the server-rendered row, so this recompute
          // patched pipelineState right back to "needs_jd" on every completed
          // run — permanently stuck on "Needs full JD" until a real navigation.
          jd_quality:   data.jd_quality ?? job.jd_quality ?? null,
          role_match:   data.role_match ?? job.role_match ?? null,
        },
        latestRun: { ...runRef, passed_initial_gate: gates.passedInitial, passed_final_gate: gates.passedFinal },
        latestLetter: letterRef,
      }),
    });
  }, [data, job, onPatchJob]);

  const pending = (
    <div className="flex items-center gap-2 py-6 text-label text-text-3">
      <Loader2 className="w-4 h-4 animate-spin" /> Loading…
    </div>
  );

  const header = (
    <DetailHeader
      job={job}
      description={data?.description ?? null}
      manualJdText={data?.manual_jd_text ?? null}
      detailLoaded={!!data}
      letterId={data?.cover_letter?.pass_3_final ? data.cover_letter.id : null}
      letterSubject={data?.cover_letter?.email_subject ?? null}
      letterBody={data?.cover_letter?.email_body ?? null}
      cvStoragePath={run?.tailored_cv_storage_path ?? null}
      run={run}
      onClosed={onClose}
      onChanged={refresh}
      onAppliedChanged={(appliedAt) => onPatchJob?.(job.id, { applied_at: appliedAt })}
      mobile={mobile}
    />
  );

  return (
    <div className={mobile ? "fixed inset-0 z-40 bg-surface flex flex-col" : inline ? "flex flex-col" : "flex flex-col h-full overflow-hidden"}>
      {(mobile || inline) && (
        <div className="flex items-center justify-between px-4 py-2 border-b border-border shrink-0">
          <button type="button" onClick={onClose} className="inline-flex items-center gap-1.5 text-label text-text-2 hover:text-text">
            {mobile ? <><X className="w-4 h-4" /> Back to list</> : <><ChevronUp className="w-4 h-4" /> Collapse</>}
          </button>
        </div>
      )}

      {error ? (
        <>
          {header}
          <div className="flex-1 flex items-center justify-center px-6">
            <p className="text-label text-red-600">{error}</p>
          </div>
        </>
      ) : (
        <Tabs.Root value={activeTab} onValueChange={setTab} className={inline ? "flex flex-col" : "flex flex-col flex-1 min-h-0"}>
          {/* Inline (accordion) mode has no internal scroll region — the page
              itself scrolls through the expanded job — so without `sticky`
              the header+tabs would scroll away with the description. `sticky`
              keeps them pinned together at the top of the viewport for
              exactly as long as this job's box is on screen, then releases
              naturally once the box scrolls past (native sticky behaviour,
              no JS needed). `bg-surface` so the scrolling description doesn't
              show through underneath. */}
          <div className={inline ? "sticky top-0 z-10 bg-surface" : ""}>
            {header}
            <Tabs.List className="flex items-center gap-1 border-b border-border px-8 shrink-0 mt-3.5 bg-[#fafbfc]">
              <Tabs.Trigger value="jd" className="text-[13.5px] font-semibold px-[14px] py-[10px]">Job description</Tabs.Trigger>
              {hasScore && <Tabs.Trigger value="match" className="text-[13.5px] font-semibold px-[14px] py-[10px]">Match &amp; score</Tabs.Trigger>}
              {hasCv && <Tabs.Trigger value="cv" className="text-[13.5px] font-semibold px-[14px] py-[10px]">Tailored CV</Tabs.Trigger>}
              {hasLetter && <Tabs.Trigger value="cover" className="text-[13.5px] font-semibold px-[14px] py-[10px]">Cover letter</Tabs.Trigger>}
            </Tabs.List>
          </div>

          <div
            className={`px-8 py-5 pb-9 text-[14.5px] leading-relaxed ${inline ? "" : "flex-1 min-h-0 overflow-y-auto"}`}
            style={inline ? undefined : { maxWidth: 860 }}
          >
            {/* keepMounted on the two tabs that own fetched state (the CV
                preview downloads and renders a PDF; the letter loads its own
                body). Unmounting them threw that work away, so every visit to
                a tab the user had already opened started again from a spinner. */}
            <Tabs.Content value="jd"><JobDescriptionTab job={job} detail={data} loading={loading} /></Tabs.Content>
            {hasScore && (
              <Tabs.Content value="match">
                {loading ? pending : <MatchScoreTab job={job} detail={data} />}
              </Tabs.Content>
            )}
            {hasCv && (
              <Tabs.Content value="cv" keepMounted>
                {run ? <TailoredCvTab run={run} /> : pending}
              </Tabs.Content>
            )}
            {hasLetter && (
              <Tabs.Content value="cover" keepMounted>
                {data?.cover_letter
                  ? <CoverLetterTab
                      // Forces a clean remount if the letter's identity ever
                      // changes under an already-mounted (keepMounted) tab —
                      // the letter/message local state below is only ever
                      // seeded from `letter` on first mount, so without this
                      // it would keep serving a stale/placeholder letter's
                      // text after a real one replaces it in `data`.
                      key={data.cover_letter.id}
                      jobId={job.id}
                      letter={data.cover_letter}
                      applied={!!job.applied_at}
                      onChanged={refresh}
                    />
                  : pending}
              </Tabs.Content>
            )}
          </div>
        </Tabs.Root>
      )}
    </div>
  );
}

export function BoardDetailPanel({
  job, onClose, onPatchJob, mobile = false, inline = false,
}: {
  job: BoardJob;
  onClose: () => void;
  onPatchJob?: (id: string, patch: Partial<BoardJob>) => void;
  /** Renders as a full-screen overlay with a back button (mobile drawer). */
  mobile?: boolean;
  /** Renders full-width, natural height, no internal scroll — the flat
   *  Applied/Favourite list's accordion-style "expand in place" row. */
  inline?: boolean;
}) {
  return (
    <BoardDetailPanelInner
      key={job.id}
      job={job}
      onClose={onClose}
      onPatchJob={onPatchJob}
      mobile={mobile}
      inline={inline}
    />
  );
}

export function EmptyDetail() {
  return (
    <div className="hidden lg:flex flex-col items-center justify-center h-full text-center px-6">
      <p className="text-title font-semibold text-text mb-1">Select a job</p>
      <p className="text-label text-text-3">Click a job on the left to see its details here.</p>
    </div>
  );
}

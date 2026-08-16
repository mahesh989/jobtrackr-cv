"use client";

/**
 * Detail-pane header — title, meta line, always-visible open-listing/close
 * icons, a Status/Analysed/Employment stat-tile row (demo `.fa-stats`), and
 * stacked action buttons (primary + ⋯ menu, then Download/Full analysis).
 *
 * Deliberately does NOT reuse `AnalyzeJobButton`'s navigate-to-analysis-page
 * behaviour: the whole point of the master-detail redesign is staying on the
 * board, so a successful (re-)analyse here just refreshes this panel + the
 * list in place instead of routing away.
 */

import { useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { ExternalLink, Loader2, MoreHorizontal, StopCircle, X } from "lucide-react";
import { IconButton, MenuItem } from "@/components/ui";
import { RunStatus } from "@/lib/constants";
import { MIN_INITIAL_ATS, MIN_FINAL_ATS } from "@/lib/atsThresholds";
import { markJobDismissed } from "@/lib/actions/jobs";
import { cancelAnalysisRun } from "@/lib/actions/runs";
import { triggerReanalyze } from "@/lib/analyzeJob";
import { shallowSetParams } from "../../lib/shallowNav";
import { JobEditModal } from "../JobEditModal";
import { Distance } from "../FeedCards";
import { PIPELINE_STATE_META } from "../../lib/pipelineState";
import { relativeDate, EMPLOYMENT_CHIP_LABEL } from "../../lib/smartFeedUtils";
import { useJobRunStatus } from "../../lib/useJobRunStatus";
import { useIsDesktop } from "../../lib/useIsDesktop";
import { AnalysisProgressModal } from "./AnalysisProgressModal";
import { ApplyModal } from "./ApplyModal";
import { DownloadMenu } from "./DownloadMenu";
import { FullAnalysisModal } from "./FullAnalysisModal";
import type { BoardJob } from "../../lib/jobFilters";
import type { BoardDetailRun } from "../../lib/boardDetailTypes";

export function DetailHeader({
  job, description = null, manualJdText = null, detailLoaded = false,
  letterId = null, letterSubject = null, letterBody = null,
  cvStoragePath = null, run = null, onClosed, onChanged, onAppliedChanged, mobile = false,
}: {
  job: BoardJob;
  /** Raw JD text from the pane's per-job payload (no longer on the board row).
   *  Null until that fetch resolves — see `detailLoaded`. */
  description?: string | null;
  manualJdText?: string | null;
  /** False while the per-job payload is still in flight. The edit modal must
   *  not compare the user's text against a not-yet-loaded original, or it would
   *  store a redundant copy of the scrape as a manual override. */
  detailLoaded?: boolean;
  /** Cover letter for the latest run, from the pane's payload — lets the Apply
   *  popup offer the drafted message and the send-email path. Null while that
   *  payload is still loading, or when the job has no letter. */
  letterId?: string | null;
  /** Stored message for that letter, straight off the pane's payload. Handed to
   *  the Apply popup so it can render without a round trip — see its module note. */
  letterSubject?: string | null;
  letterBody?: string | null;
  /** Tailored-CV markdown path for the latest run — feeds the Download menu.
   *  Null while the payload loads, or when no CV was generated. */
  cvStoragePath?: string | null;
  /** The latest run from the pane's own payload. `job.progress` comes from the
   *  server-rendered list and does not catch up until a real navigation, so
   *  after an analysis finishes in place it still claims the job was never
   *  analysed — which left this header offering "Analyse this job" on a job
   *  that had just produced a score. Where this is present it wins. */
  run?: BoardDetailRun | null;
  /** Called after a dismiss/archive so the parent can clear ?job= and drop the card. */
  onClosed: () => void;
  /** Called after any mutation that should refresh both this panel and the list. */
  onChanged: () => void;
  /** Called once the job's applied state has actually changed, so the board list
   *  can patch its own copy of the row — a timestamp when it was applied, null
   *  when that was undone. Separate from `onChanged`, which only refetches this
   *  pane. */
  onAppliedChanged?: (appliedAt: string | null) => void;
  /** SmartFeed mounts BoardDetailPanel twice — a desktop pane (`hidden lg:block`)
   *  and a mobile one (`lg:hidden`) — so this header renders twice at every
   *  breakpoint. CSS hides the wrong one, but the progress popup is a portal to
   *  document.body and escapes that hiding, which stacked two identical modals.
   *  Only the desktop instance renders it; being display:none doesn't stop a
   *  portal, so the single modal still shows correctly on mobile. */
  mobile?: boolean;
}) {
  const [showEdit, setShowEdit] = useState(false);
  // `submitting` covers only the enqueue request. Whether the *pipeline* is
  // running comes from the analysis_runs row over Realtime, so the indicator
  // survives closing the pane, switching jobs, and refreshes — and clears when
  // the run genuinely finishes rather than when the POST resolves.
  const [submitting, setSubmitting]   = useState(false);
  const [showApply, setShowApply]     = useState(false);
  // Tri-state, not a boolean: this pane deliberately never calls
  // router.refresh(), so `job.applied_at` stays frozen at whatever the server
  // render said until a real navigation. It has to be able to override that
  // in BOTH directions — `false` alone couldn't express "just un-applied".
  const [appliedOverride, setAppliedOverride] = useState<boolean | null>(null);
  const [unapplying, setUnapplying]   = useState(false);
  const [menuOpen, setMenuOpen]       = useState(false);
  const [error, setError]             = useState<string | null>(null);
  const [showFullAnalysis, setShowFullAnalysis] = useState(false);

  // A card's Apply button hands off via `?job=<id>&apply=1` rather than
  // applying inline, so the popup (and its confirmation step) is the only way
  // a job gets stamped. Consumed once and stripped from the URL so a reload
  // doesn't reopen it.
  //
  // Only ONE twin acts on it — SmartFeed mounts this header twice and CSS
  // hides one, but ApplyModal is a portal to document.body and escapes that
  // hiding, so both instances setting showApply would stack two identical
  // popups. This used to be hardcoded to the desktop twin (`!mobile`), which
  // silently broke on any viewport under the `lg` breakpoint (~1024px,
  // including a perfectly ordinary non-maximized desktop window): the visible
  // pane there is the MOBILE twin, but the DESKTOP twin still portal-rendered
  // the modal per the old rule — and that twin's own useBoardDetail fetch is
  // gated off at that same viewport (see useIsDesktop), so its `data` never
  // arrives and the message showed "Loading your message…" forever, even
  // though the letter had been sitting fully generated in the database the
  // whole time. Gating on `isThisInstanceLive` instead ties "which twin shows
  // the modal" to "which twin actually has data" — they're now the same
  // question, so they can't disagree.
  const isDesktopViewport = useIsDesktop();
  const isThisInstanceLive = mobile ? !isDesktopViewport : isDesktopViewport;
  const sp       = useSearchParams();
  const pathname = usePathname();
  const [applyConsumed, setApplyConsumed] = useState(false);
  const wantsApply = isThisInstanceLive && sp.get("apply") === "1" && sp.get("job") === job.id;
  if (wantsApply && !applyConsumed) {
    setApplyConsumed(true);
    setShowApply(true);
  }
  // Re-arm once the param is gone (closeApply strips it). Without this, closing
  // the popup and clicking the same card's Apply again would re-add `apply=1`
  // to a component that had already marked it consumed, and nothing would open.
  if (!wantsApply && applyConsumed) setApplyConsumed(false);

  function closeApply() {
    setShowApply(false);
    if (sp.get("apply")) {
      const next = new URLSearchParams(Array.from(sp.entries()));
      next.delete("apply");
      shallowSetParams(pathname, next);
    }
  }

  // Seed as idle when the stored run is a stale zombie (see isRunLive), so the
  // chip and progress popup don't spin forever on a run that died days ago.
  // Realtime events are live by definition and always take over.
  const seedStatus = job.pipelineState === "analysing" ? job.progress.latest_run_status : null;
  // Refresh fires the instant the run settles — `onChanged` (`refresh` in
  // BoardDetailPanel) only bumps local state to refetch this pane's own
  // board-detail payload, so it can't reset the board's scroll or tear away
  // the popup (that was true of an older version wired to router.refresh(),
  // which is why this used to be deferred until the popup was dismissed —
  // the deferral just meant "no manual refresh needed" wasn't actually true).
  const { status, running, steps, runId, markStarting, markStartFailed, markStarted } = useJobRunStatus(
    job.id,
    seedStatus,
    onChanged,
    job.progress.latest_run_id,
  );
  const analysing = submitting || running;

  const [cancelling, setCancelling] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  /** Stop the live run. The orchestrator polls its own row before each
   *  AI-heavy step and aborts when it sees status=failed + "Cancelled…", so
   *  this both updates the UI (via Realtime) and genuinely halts the pipeline.
   *  Steps already finished keep their spent tokens — only the remaining ones
   *  are prevented. */
  async function stopAnalysis() {
    if (!runId || cancelling) return;
    setCancelling(true);
    setError(null);
    try {
      await cancelAnalysisRun(runId);
      setCancelled(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not stop the analysis");
    } finally {
      setCancelling(false);
    }
  }

  // The popup opens on its own whenever a run is live for this job — including
  // runs started from the ⋯ menu, from the card, or in another tab. Dismissing
  // only hides it; `progressDismissedFor` is keyed by phase so a later
  // completion still surfaces, and the header chip reopens it at any time.
  const [progressDismissed, setProgressDismissed] = useState<string | null>(null);
  // A user-cancelled run lands as status=failed with "Cancelled by user" (the
  // contract the orchestrator polls for), so reporting it as "Analysis failed"
  // told the user their own Stop was an error. Track it as its own phase.
  // "completed" is asserted only when the run row actually says so. It used to
  // be the catch-all `else`, which meant any moment `analysing` read false —
  // notably the gap between the enqueue POST resolving and the first Realtime
  // event — was reported to the user as a finished analysis, steps and all.
  const phase: "running" | "completed" | "failed" | "cancelled" =
    analysing ? "running"
    : cancelled ? "cancelled"
    : status === RunStatus.FAILED ? "failed"
    : status === RunStatus.COMPLETED ? "completed"
    : "running";
  // Only ever auto-show for a live run; terminal phases show only if the popup
  // was already open when the run settled (so it can report the outcome).
  const [wasOpen, setWasOpen] = useState(false);
  if (analysing && !wasOpen) setWasOpen(true);
  const showProgress = wasOpen && progressDismissed !== phase;

  const meta = PIPELINE_STATE_META[job.pipelineState ?? "discovered"];

  async function onDismiss() {
    try { await markJobDismissed(job.id, job.profile_id); onClosed(); }
    catch { setError("Could not archive this job."); }
  }

  /** Undo an applied mark. Nothing else on the board can do this — a card's
   *  Apply button stamps `applied_at` with no confirmation, and until this
   *  existed the only way back was the /applications Sent tab's "Move back to
   *  pool".
   *
   *  PATCH rather than a revalidatePath-based server action, for the same reason
   *  ApplyModal takes the route: revalidatePath refetches the whole
   *  server-rendered board and resets its scroll out from under the user — here
   *  it would also tear this row out of the flat Applied list mid-click. The
   *  route already accepts `applied_at: null`. */
  async function onUnapply() {
    if (unapplying) return;
    setUnapplying(true); setError(null);
    try {
      const res = await fetch(`/api/jobs/${job.id}`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ applied_at: null }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `Failed (${res.status})`);
      }
      setAppliedOverride(false);
      onAppliedChanged?.(null);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not undo this application");
    } finally {
      setUnapplying(false);
    }
  }

  async function runAnalyze(override?: "thin_jd" | "initial_gate" | "all") {
    if (analysing) return;
    markStarting();  // flip card + panel on the same frame, before the POST
    setSubmitting(true); setError(null);
    try {
      const url = override ? `/api/jobs/${job.id}/analyze?override=${override}` : `/api/jobs/${job.id}/analyze`;
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `Failed (${res.status})`);
      // Adopt the real run id, superseding the optimistic flag. Without it the
      // UI reads the run as finished during the gap before the first Realtime
      // event, and the progress popup flips to "Analysis complete" with no
      // steps done.
      if (json.run_id) markStarted(json.run_id);
      onChanged();
    } catch (e) {
      markStartFailed();
      setError(e instanceof Error ? e.message : "Analysis failed to start");
    } finally {
      setSubmitting(false);
    }
  }

  async function onReanalyze() {
    if (analysing) return;
    markStarting();
    setSubmitting(true); setError(null);
    try {
      const newRunId = await triggerReanalyze(job.id);
      if (newRunId) markStarted(newRunId);
      onChanged();
    } catch (e) {
      markStartFailed();
      setError(e instanceof Error ? e.message : "Could not re-analyse");
    } finally {
      setSubmitting(false);
    }
  }

  // `job.applied_at` comes from the server-rendered list and only catches up
  // on the next real navigation (see BoardDetailPanel — refresh() is pane-local
  // on purpose). Without this, a successful Apply leaves this same header
  // still reading "Apply now" right after its own popup just confirmed the
  // opposite.
  const isApplied = appliedOverride ?? !!job.applied_at;
  const needsJd   = job.pipelineState === "needs_jd";

  // Everything below prefers the pane's freshly-fetched run over the board row
  // it was rendered from. Without this the whole action row stays frozen on
  // whatever was true when the page was server-rendered: finishing an analysis
  // repainted the tabs (they read the payload) but left the button saying
  // "Analyse this job", and only a manual refresh fixed it.
  const liveScore   = run ? run.tailored_match_score ?? run.match_score : null;
  const hasAnalysis = job.progress.has_analysis || liveScore != null;
  const failed      = run ? run.status === "failed" : job.progress.latest_run_status === "failed";
  const notAnalysed = !hasAnalysis && !needsJd && !failed;

  const thresholds = job.atsThresholds ?? { initial: MIN_INITIAL_ATS, final: MIN_FINAL_ATS };
  // A score that hasn't cleared the final gate is what "Apply anyway" names.
  // pipelineState carries this for jobs the server already knew about; for one
  // analysed a moment ago the run's own score is the only source.
  const belowGate =
    job.pipelineState === "below_final" ||
    job.pipelineState === "below_initial" ||
    job.pipelineState === "role_mismatch" ||
    (!job.progress.has_analysis && liveScore != null && liveScore < thresholds.final);

  const latestRunId  = run?.id ?? job.progress.latest_run_id;
  const analysisHref = latestRunId ? `/jobs/${job.id}/analyze/${latestRunId}` : null;
  // When the analysis last produced a result — shown right-aligned on the
  // status line so "Ready to apply · ATS 67 → 81" gains a recency anchor.
  const lastAnalysedAt = job.progress.has_analysis ? job.progress.last_progress_at : null;

  // Demo `.fa-stats` "Analysed"/"Employment" tiles.
  const analysedText = lastAnalysedAt
    ? relativeDate(lastAnalysedAt)
    : needsJd ? "Needs JD"
    : failed  ? "Failed"
    : "Not yet";
  const employmentTypesList = (job.employment_types ?? []).map((t) => EMPLOYMENT_CHIP_LABEL[t] ?? t);
  const employmentText = employmentTypesList.length ? employmentTypesList.join(" / ") : "—";

  // Demo `.fa-actions`: primary + Download/Full-analysis/Re-analyse only
  // take up a second row when there's something to put in it.
  const hasDownload     = job.progress.has_tailored_cv || job.progress.has_cover_letter || !!cvStoragePath || !!letterId;
  const hasFullAnalysis = !!analysisHref;
  const hasReanalyse    = job.progress.has_analysis && !!job.progress.latest_run_id;

  return (
    <div className="border-b border-border px-8 pt-4 pb-3">
      {/* flex-wrap + a guaranteed minimum width on the title column: the
          persistent open/close icons don't shrink, so at narrower widths
          (this header now also renders full-width, unconstrained, in the
          Applied/Favourite accordion — see BoardDetailPanel's `inline` mode)
          it used to just take the space it needed and leave the flex-1 title
          column with 0px, wrapping the title one word per line. Wrapping the
          icons onto their own row instead keeps the title readable. */}
      <div className="flex items-start gap-3 flex-wrap">
        <div className="min-w-[220px] flex-1">
          <a href={job.url} target="_blank" rel="noopener noreferrer" className="text-[19px] font-bold text-text hover:text-[var(--brand)] leading-tight tracking-tight">
            {job.title}
          </a>
          <p className="text-[13px] text-text-2 mt-1">
            <span className="font-semibold">{job.company}</span>
            {job.location && <> · {job.location}</>}
            {typeof job.distance_km === "number" && <> · <Distance km={job.distance_km} method={job.distance_method ?? null} /></>}
            {" · "}
            <span className="uppercase font-semibold" style={{ fontSize: 11 }}>{job.source}</span>
          </p>
        </div>

        {/* Demo `.fa-top-actions`: open-listing + close are always visible
            here, on every job — previously the only way to close the pane
            on desktop was the scrim/Esc, and "open the listing" only lived
            three clicks deep in the ⋯ menu. */}
        <div className="flex items-center gap-1 shrink-0">
          <IconButton
            onClick={() => window.open(job.url, "_blank", "noopener,noreferrer")}
            aria-label="Open listing"
            title="Open listing"
            size="md"
            variant="ghost"
            icon={<ExternalLink className="w-4 h-4" />}
          />
          <IconButton onClick={onClosed} aria-label="Close" title="Close" size="md" variant="ghost" icon={<X className="w-4 h-4" />} />
        </div>
      </div>

      {/* Always-visible running indicator. The action buttons below only
          show "Analysing…" on the Analyse/Retry branches, which aren't
          rendered for an already-analysed job — so without this,
          re-analysing showed nothing at all. Doubles as the way back into
          the progress popup after dismissing it. */}
      {analysing && (
        <span className="mt-3 inline-flex items-center rounded-[9px] border border-[var(--brand)]/30 bg-[var(--brand)]/10 overflow-hidden">
          <button
            type="button"
            onClick={() => { setWasOpen(true); setProgressDismissed(null); }}
            title="Show analysis progress"
            className="inline-flex items-center gap-1.5 px-[12px] py-[7px] text-[13px] font-semibold whitespace-nowrap text-[var(--brand)] hover:bg-[var(--brand)]/15 transition-colors"
          >
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Analysing…
          </button>
          <button
            type="button"
            onClick={stopAnalysis}
            disabled={cancelling || !runId}
            title="Stop this analysis — steps already finished are kept, the remaining ones won't run"
            aria-label="Stop analysis"
            className="inline-flex items-center gap-1 border-l border-[var(--brand)]/30 px-[10px] py-[7px] text-[13px] font-semibold text-danger hover:bg-danger-subtle transition-colors disabled:opacity-50"
          >
            {cancelling
              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : <StopCircle className="w-3.5 h-3.5" />}
            Stop
          </button>
        </span>
      )}

      {/* Demo `.fa-stats`: Status / Analysed / Employment tiles, replacing
          the old single state-chip + text status line. */}
      <div className="grid grid-cols-3 gap-2 mt-3">
        <StatTile k="Status">
          <span className={`pulse-dot inline-block w-2 h-2 rounded-full bg-current ${DOT_COLOR[meta.tone] ?? DOT_COLOR.neutral}`} />
          <span className="truncate">{meta.label}</span>
        </StatTile>
        <StatTile k="Analysed">{analysedText}</StatTile>
        <StatTile k="Employment">{employmentText}</StatTile>
      </div>
      {extraNote(job, description, detailLoaded) && (
        <p className="text-label text-text-2 mt-2">{extraNote(job, description, detailLoaded)}</p>
      )}

      {/* Demo `.fa-actions`: primary action full-width (+ the ⋯ menu beside
          it), then Download / Full analysis stacked below as a second row —
          not crammed into one row of small pills like before. */}
      <div className="flex flex-col gap-2 mt-3">
        <div className="flex items-center gap-2">
          {isApplied ? (
            <span className="flex-1 inline-flex items-center justify-center px-[14px] py-[10px] rounded-[8px] text-[13px] font-semibold bg-success-subtle text-success">✓ Applied</span>
          ) : needsJd ? (
            <button type="button" onClick={() => setShowEdit(true)}
              className="flex-1 inline-flex items-center justify-center px-[14px] py-[10px] rounded-[8px] text-[13px] font-semibold bg-[var(--brand)] text-[var(--brand-fg)] hover:opacity-90 transition-opacity"
            >Add job description</button>
          ) : failed && !analysing ? (
            <button type="button" onClick={() => runAnalyze()} disabled={analysing}
              className="flex-1 inline-flex items-center justify-center gap-1.5 px-[14px] py-[10px] rounded-[8px] text-[13px] font-semibold bg-[var(--brand)] text-[var(--brand-fg)] hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              {analysing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
              {analysing ? "Analysing…" : "Retry analysis"}
            </button>
          ) : notAnalysed && !analysing ? (
            <button type="button" onClick={() => runAnalyze()} disabled={analysing}
              className="flex-1 inline-flex items-center justify-center gap-1.5 px-[14px] py-[10px] rounded-[8px] text-[13px] font-semibold bg-[var(--brand)] text-[var(--brand-fg)] hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              {analysing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
              {analysing ? "Analysing…" : "Analyse this job"}
            </button>
          ) : (
            <button type="button" onClick={() => setShowApply(true)}
              className="flex-1 inline-flex items-center justify-center px-[14px] py-[10px] rounded-[8px] text-[13px] font-semibold bg-[var(--brand)] text-[var(--brand-fg)] hover:opacity-90 transition-opacity"
            >
              {belowGate ? "Apply anyway" : "Apply now"}
            </button>
          )}

          <div className="relative shrink-0">
            <IconButton onClick={() => setMenuOpen((v) => !v)} aria-label="More actions" size="lg" variant="outline" icon={<MoreHorizontal className="w-3.5 h-3.5" />} />
            {menuOpen && (
              <div className="absolute right-0 top-full mt-1 z-30 min-w-[180px] rounded-md border border-border bg-surface shadow-lg py-1 text-label" onMouseLeave={() => setMenuOpen(false)}>
                <MenuItem onClick={() => { setMenuOpen(false); setShowEdit(true); }}>Edit job description…</MenuItem>
                {(job.pipelineState === "below_initial" || job.pipelineState === "role_mismatch") && (
                  <MenuItem onClick={() => { setMenuOpen(false); runAnalyze("all"); }} disabled={analysing}>Force full analysis</MenuItem>
                )}
                {isApplied && (
                  <MenuItem onClick={() => { setMenuOpen(false); onUnapply(); }} disabled={unapplying}>
                    {unapplying ? "Undoing…" : "Mark as not applied"}
                  </MenuItem>
                )}
                <MenuItem onClick={() => { setMenuOpen(false); onDismiss(); }} danger>Dismiss</MenuItem>
              </div>
            )}
          </div>
        </div>

        {(hasDownload || hasFullAnalysis || hasReanalyse) && (
          <div className="flex flex-wrap gap-2">
            {/* Gated on the board's own progress flags, not the fetched
                payload, so the control paints with the rest of the header
                instead of popping in a beat later; individual items stay
                disabled until `detailLoaded` gives them real storage paths.
                flex-wrap + flex-1 (not a fixed grid-cols) so this reads the
                same whether one, two, or all three of these show up. */}
            {hasDownload && (
              <div className="flex-1 min-w-[140px]">
                <DownloadMenu
                  jobId={job.id}
                  company={job.company}
                  hiringManager={job.hiring_manager ?? null}
                  cvStoragePath={cvStoragePath}
                  letterId={letterId}
                  loaded={detailLoaded}
                  fullWidth
                />
              </div>
            )}
            {hasFullAnalysis && (
              <button
                type="button"
                onClick={() => setShowFullAnalysis(true)}
                className="flex-1 min-w-[140px] inline-flex items-center justify-center gap-1.5 px-[14px] py-[10px] rounded-[8px] text-[13px] font-semibold border border-[var(--brand)]/35 text-[var(--brand)] bg-transparent hover:bg-[var(--brand)]/6 transition-colors"
                title="Opens the full analysis in a popup, without leaving the board"
              >Full analysis ↗</button>
            )}
            {/* Previously buried in the ⋯ menu — re-analysing is common
                enough (and important enough to not miss) that it belongs
                next to Download/Full analysis instead of a click deeper. */}
            {hasReanalyse && (
              <button
                type="button"
                onClick={onReanalyze}
                disabled={analysing}
                className="flex-1 min-w-[140px] inline-flex items-center justify-center gap-1.5 px-[14px] py-[10px] rounded-[8px] text-[13px] font-semibold border border-[var(--brand)]/35 text-[var(--brand)] bg-transparent hover:bg-[var(--brand)]/6 transition-colors disabled:opacity-50"
              >
                {analysing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                Re-analyse
              </button>
            )}
          </div>
        )}
      </div>

      {error && <p className="text-label text-danger mt-2">{error}</p>}

      {showEdit && (
        <JobEditModal
          jobId={job.id}
          jobUrl={job.url}
          originalJd={detailLoaded ? description ?? "" : undefined}
          initialManual={manualJdText ?? job.manual_jd_text ?? null}
          initialEmail={job.contact_email ?? null}
          initialHiringMgr={job.hiring_manager ?? null}
          initialCompanyAddress={job.company_address ?? null}
          onClose={() => setShowEdit(false)}
          onSaved={() => { setShowEdit(false); onChanged(); }}
          onAnalysisStarted={(runId) => { markStarted(runId); onChanged(); }}
        />
      )}

      {/* No `mobile` guard, unlike the progress popup: this one only opens on a
          click, and CSS only ever lets the user click the pane it is showing. */}
      {showApply && (
        <ApplyModal
          job={job}
          letterId={letterId}
          letterSubject={letterSubject}
          letterBody={letterBody}
          cvStoragePath={cvStoragePath}
          onClose={closeApply}
          onApplied={() => {
            setAppliedOverride(true);
            onAppliedChanged?.(new Date().toISOString());
            onChanged();
          }}
          onChanged={onChanged}
        />
      )}

      {showProgress && !mobile && (
        <AnalysisProgressModal
          jobTitle={job.title}
          steps={steps}
          phase={phase}
          onStop={runId ? stopAnalysis : undefined}
          stopping={cancelling}
          analysisHref={runId ? `/jobs/${job.id}/analyze/${runId}` : analysisHref}
          onDismiss={() => {
            setProgressDismissed(phase);
            if (phase !== "running") setWasOpen(false);
            // The pane's own data already refreshed the moment the run settled
            // (see useJobRunStatus above) — nothing left to pull in here.
          }}
        />
      )}

      {showFullAnalysis && latestRunId && (
        <FullAnalysisModal
          job={job}
          runId={latestRunId}
          onClose={() => setShowFullAnalysis(false)}
        />
      )}
    </div>
  );
}

// Demo `.fa-stat-v`'s dot colour — reused for `.pulse-dot`'s ring via
// `background: currentColor`, so setting text colour here sets both at once.
const DOT_COLOR: Record<string, string> = {
  success: "text-success", warning: "text-warning", danger: "text-danger",
  info: "text-info", neutral: "text-text-3",
};

function StatTile({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-[8px] border border-border bg-surface px-[10px] py-[8px]">
      <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-text-3">{k}</p>
      <p className="mt-[3px] flex items-center gap-1.5 text-[14px] font-semibold text-text truncate">{children}</p>
    </div>
  );
}

/**
 * The extra signals that don't fit a stat tile — ATS score, salary and
 * employment type now live in the Status/Employment tiles and the Match &
 * score tab (repeating them here would be the exact redundancy the demo's
 * design brief calls out), so this only ever surfaces genuinely additional
 * context: what happened with the cover letter, a contact email on file, or
 * why analysis stopped early.
 */
function extraNote(
  job: BoardJob,
  description: string | null,
  detailLoaded: boolean,
): string {
  const state = job.pipelineState ?? "discovered";
  const parts: string[] = [];

  if (state === "applied") {
    if (job.progress.has_tailored_cv) parts.push("Tailored CV + cover letter sent via listing");
  } else if (state === "below_final" || state === "below_initial") {
    if (!job.progress.has_cover_letter) parts.push("Cover letter skipped");
  } else if (state === "role_mismatch") {
    parts.push("Analysis stopped after scoring");
  } else if (state === "needs_jd") {
    // Only claim a length once the JD payload has actually arrived — before
    // that we'd assert "only 0 characters scraped" for every job.
    const descLen = (description ?? "").length;
    if (detailLoaded && descLen > 0) parts.push(`Only ${descLen} characters scraped`);
  }
  if (job.contact_email && (state === "below_final" || state === "below_initial" || state === "role_mismatch")) {
    parts.push("Contact email on file");
  }
  return parts.filter(Boolean).join(" · ");
}

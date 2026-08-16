"use client";

/**
 * Card shell: exit animation, footer and salary line.
 *
 * Split out of the former single-file FeedCards.tsx (839 lines). Pure code
 * motion — component bodies and ordering are unchanged. Every component is
 * still importable from "./FeedCards".
 * 
 */
import { useContext, useState } from "react";
import { CheckCircle2, ExternalLink, Loader2, StopCircle } from "lucide-react";
import { markJobDismissed, toggleStarJob } from "@/lib/actions/jobs";
import { cancelAnalysisRun } from "@/lib/actions/runs";
import { IconButton } from "@/components/ui";
import { JobEditModal } from "../JobEditModal";
import { BoardJob, MANUAL_JD_MIN_CHARS } from "../../lib/jobFilters";
import { useJobSelection } from "../feedSelection";
import { EMPLOYMENT_CHIP_LABEL, formatSalary } from "@/features/jobs/lib/smartFeedUtils";
import { PIPELINE_STATE_META } from "@/features/jobs/lib/pipelineState";
import { useJobRunStatus } from "../../lib/useJobRunStatus";
import { SourcePill } from "./chips";
import { CardActionsContext } from "./context";
import { CardMenu } from "../CardMenu";
export function CardFooter({ job }: { job: BoardJob }) {
  const ctx = useContext(CardActionsContext);
  const selection = useJobSelection();
  const state = job.pipelineState ?? "discovered";
  const meta = PIPELINE_STATE_META[state];
  // `submitting` covers only the enqueue POST; whether the pipeline is
  // actually running comes from Realtime (mirrors DetailHeader's own
  // useJobRunStatus). Without this the card's Analyse button fired the
  // request and gave no feedback at all — no spinner, no disabled state,
  // nothing — because the old code awaited the fetch and then just dropped
  // the result on the floor.
  const [submitting, setSubmitting] = useState(false);
  const [analyseError, setAnalyseError] = useState<string | null>(null);
  const seedStatus = state === "analysing" ? job.progress.latest_run_status : null;
  const { running, runId, markStarting, markStartFailed, markStarted } = useJobRunStatus(job.id, seedStatus, undefined, job.progress.latest_run_id);
  const analysing = submitting || running;
  const [cancelling, setCancelling] = useState(false);

  /** Same Stop the detail header offers, mirrored here so the card the user
   *  started the run from can also end it — the run keeps going across a
   *  refresh or a pane close, so "how do I stop this?" has to be answerable
   *  from wherever the job is visible. */
  async function onStop(e: React.MouseEvent) {
    e.stopPropagation();
    if (!runId || cancelling) return;
    setCancelling(true);
    setAnalyseError(null);
    try { await cancelAnalysisRun(runId); }
    catch { setAnalyseError("Could not stop the analysis"); }
    finally { setCancelling(false); }
  }

  const toneColors: Record<string, string> = {
    success: "bg-success-subtle text-success border-success-border",
    warning: "bg-warning-subtle text-warning border-warning-border",
    danger:  "bg-danger-subtle text-danger border-danger-border",
    neutral: "bg-[var(--surface-2)] text-text-2 border-border",
  };
  const dotColors: Record<string, string> = {
    success: "bg-success",
    warning: "bg-warning",
    danger:  "bg-danger",
    neutral: "bg-text-3",
  };

  // The chip carries the pipeline-state label only (handoff §2.4): the score
  // lives exclusively in the card's gauge, so printing numbers here too would
  // duplicate it (and the gauge's "from {initial}" reads the lift story).
  const chipDisplay = meta.label;

  /** Hands off to the detail pane's Apply popup instead of applying here.
   *  This used to open the listing and call markJobApplied in the same click —
   *  no confirmation — so a misclick stamped `applied_at` and the job left the
   *  active list for good. The popup asks first, and it is the same flow the
   *  panel's own Apply button uses. */
  function onApply(e: React.MouseEvent) {
    e.stopPropagation();
    if (selection?.onOpenDetailAndApply) {
      selection.onOpenDetailAndApply(job.id);
      return;
    }
    // Only reachable if a card is ever rendered outside the board's provider.
    // Open the listing rather than silently marking the job applied.
    window.open(job.url, "_blank", "noopener,noreferrer");
  }

  async function onAnalyse(e: React.MouseEvent) {
    e.stopPropagation();
    if (ctx.pending || analysing) return;
    // Optimistically flip BEFORE opening the pane and before the POST, so the
    // detail header this opens mounts already reading "Analysing…" instead of
    // offering "Analyse this job" until the enqueue round-trip returns. This is
    // the cross-instance signal — the card and the panel change on one frame.
    markStarting();
    // Select this job. The progress popup lives in the detail pane's header (it
    // needs the run's step-by-step state, which only that pane subscribes to),
    // so analysing from a card while a *different* job was selected started a
    // run the user got no popup for — the reported "works in the right panel,
    // not in the job board". Opening the job here means the same popup appears
    // from either entry point.
    selection?.onOpenDetail?.(job.id);
    setSubmitting(true); setAnalyseError(null);
    try {
      const res = await fetch(`/api/jobs/${job.id}/analyze`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? `Failed (${res.status})`);
      // Adopt the real run row; supersedes the optimistic flag. Both buttons
      // read the same run, so fixing it in one place and not the other would
      // leave the card and the panel disagreeing about the very same analysis.
      if (j.run_id) markStarted(j.run_id);
    } catch (err) {
      markStartFailed();  // roll the optimistic flag back across all instances
      setAnalyseError(err instanceof Error ? err.message : "Could not start analysis");
    } finally {
      // Hand over to the Realtime-backed `running` flag, same as DetailHeader.
      setSubmitting(false);
    }
  }

  let actionButton: React.ReactNode = null;
  if (analysing) {
    // Checked before the state branches below: a click here can happen while
    // `job.pipelineState` (server-rendered) still reads "discovered" — the
    // Realtime-backed `running` flag is what actually knows a run is live.
    actionButton = (
      <span className="inline-flex items-center rounded-[8px] border border-[var(--brand)]/30 bg-[var(--brand)]/10 overflow-hidden">
        {/* Clicking the label reopens the detail pane (and with it the progress
            popup), so a dismissed popup is recoverable from the card too. */}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); selection?.onOpenDetail?.(job.id); }}
          title="Show analysis progress"
          className="inline-flex items-center gap-1.5 px-[14px] py-[6px] text-[13.5px] font-semibold text-[var(--brand)] hover:bg-[var(--brand)]/15 transition-colors"
        >
          <Loader2 className="w-3 h-3 animate-spin" /> Analysing…
        </button>
        <button
          type="button"
          onClick={onStop}
          disabled={cancelling || !runId}
          title="Stop this analysis — steps already finished are kept, the remaining ones won't run"
          aria-label="Stop analysis"
          className="inline-flex items-center gap-1 border-l border-[var(--brand)]/30 px-[10px] py-[6px] text-[13.5px] font-semibold text-danger hover:bg-danger-subtle transition-colors disabled:opacity-50"
        >
          {cancelling
            ? <Loader2 className="w-3 h-3 animate-spin" />
            : <StopCircle className="w-3 h-3" />}
          Stop
        </button>
      </span>
    );
  } else if (state === "applied") {
    // No stale action button and no duplicate "✓ Applied" badge — the state
    // chip up the row already says "Applied" (handoff §2.4/§2.7).
    actionButton = null;
  } else if (state === "ready_to_apply" || state === "ready_to_send") {
    actionButton = (
      <button type="button" onClick={onApply}
        className="text-[13.5px] font-semibold px-[14px] py-[6px] rounded-[8px] bg-[var(--brand)] text-[var(--brand-fg)] hover:opacity-90 transition-opacity"
      >
        Apply
      </button>
    );
  } else if (state === "needs_jd") {
    actionButton = (
      <button type="button" onClick={(e) => { e.stopPropagation(); ctx.onEdit(); }}
        className="text-[13.5px] font-semibold px-[14px] py-[6px] rounded-[8px] border border-[var(--brand)]/30 text-[var(--brand)] bg-transparent hover:bg-[var(--brand)]/5 transition-colors"
      >
        Add JD
      </button>
    );
  } else if (state === "discovered" && !job.progress.has_analysis) {
    actionButton = (
      <button type="button" onClick={onAnalyse}
        className="text-[13.5px] font-semibold px-[14px] py-[6px] rounded-[8px] bg-[var(--brand)] text-[var(--brand-fg)] hover:opacity-90 transition-opacity"
      >
        Analyse
      </button>
    );
  } else if (job.progress.latest_run_status === "failed") {
    actionButton = (
      <button type="button" onClick={onAnalyse}
        className="text-[13.5px] font-semibold px-[14px] py-[6px] rounded-[8px] border border-[var(--brand)]/30 text-[var(--brand)] bg-transparent hover:bg-[var(--brand)]/5 transition-colors"
      >
        Retry
      </button>
    );
  }

  return (
    <div onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center gap-2 mt-[10px] flex-wrap">
        <SourcePill source={job.source} />
          <span className={`inline-flex items-center gap-[5px] text-[13px] font-semibold px-[11px] py-[3px] rounded-full border ${toneColors[meta.tone] ?? toneColors.neutral}`}>
          <span className={`inline-block w-[7px] h-[7px] rounded-full ${dotColors[meta.tone] ?? dotColors.neutral}`} />
          {chipDisplay}
        </span>
        <div className="flex-1" />
        {actionButton}
        {/* Demo footer's icon row (handoff §2.7/§3): open listing + the ⋯
            menu. This was the card's only dismiss path and was missing
            entirely from JobCard — CardMenu existed but was wired only into
            the unused HeroCard. */}
        <IconButton
          size="sm"
          variant="ghost"
          aria-label="Open listing"
          title="Open listing"
          icon={<ExternalLink className="w-[15px] h-[15px]" />}
          onClick={(e) => { e.stopPropagation(); window.open(job.url, "_blank", "noopener,noreferrer"); }}
        />
        <CardMenu job={job} onDismiss={ctx.onDismiss} onEdit={ctx.onEdit} pending={ctx.pending} />
      </div>
      {analyseError && <p className="text-micro text-danger mt-1">{analyseError}</p>}
    </div>
  );
}

export function SalaryLine({ job }: { job: BoardJob }) {
  const salary = formatSalary(job);
  const types = (job.employment_types ?? []).map((t) => EMPLOYMENT_CHIP_LABEL[t] ?? t);
  if (!salary && types.length === 0) return null;
  const parts = [salary, ...types].filter(Boolean);
  if (parts.length === 0) return null;
  return <p className="text-[14px] text-text-2 mt-[6px]">{parts.join(" · ")}</p>;
}

// ── card shell ──────────────────────────────────────────────────────────

type ExitPhase = "idle" | "flash" | "fading" | "gone";

export function CardShell({
  job, refSetter, hero, children, excludeKeywords }: {
  job: BoardJob;
  currentTab: string;
  refSetter: (el: HTMLDivElement | null) => void;
  hero?: boolean;
  children: React.ReactNode;
  excludeKeywords?: string;
}) {
  const [exit, setExit] = useState<ExitPhase>("idle");
  const [showEdit, setShowEdit] = useState(false);
  const [manualJd, setManualJd] = useState<string | null>(job.manual_jd_text ?? null);
  const [savedFlicker, setSavedFlicker] = useState(false);
  const [contactEmail, setContactEmail] = useState<string | null>(job.contact_email ?? null);
  const [hiringMgr, setHiringMgr] = useState<string | null>(job.hiring_manager ?? null);
  const [companyAddress, setCompanyAddress] = useState<string | null>(job.company_address ?? null);
  const [pending, setPending] = useState(false);
  const [starred, setStarred] = useState<boolean>(!!job.starred_at);
  const [starPending, setStarPending] = useState(false);

  async function onToggleStar(e: React.MouseEvent) {
    e.stopPropagation();
    if (starPending) return;
    setStarPending(true);
    setStarred((v) => !v);
    try { await toggleStarJob(job.id); }
    catch { setStarred((v) => !v); }
    finally { setStarPending(false); }
  }

  const selection  = useJobSelection();
  const selectable = selection?.selectMode ?? false;
  const checked    = selection?.isSelected(job.id) ?? false;
  const isActive   = selection?.activeJobId === job.id;
  // Focus dimming (handoff §2.1): with the detail pane open, every card but
  // the selected one recedes to 35% — the selected card keeps its brand ring
  // and reads as the only live surface. `paneOpen` comes from the same
  // selection context, so card and pane can never disagree about it.
  const paneOpen   = selection?.paneOpen ?? false;

  // Master-detail: clicking the card body opens this job in the detail pane
  // (or, in bulk-select mode, toggles selection instead — selection intent
  // wins there rather than also opening detail).
  function onCardClick() {
    if (selectable) { selection?.toggle(job.id); return; }
    selection?.onOpenDetail?.(job.id);
  }

  async function onDismiss() {
    if (exit !== "idle" || pending) return;
    setPending(true);
    setExit("fading");
    setTimeout(() => setExit("gone"), 450);
    try { await markJobDismissed(job.id, job.profile_id); }
    catch { setExit("idle"); }
    finally { setPending(false); }
  }

  if (exit === "gone") return null;

  const isFading = exit === "fading";
  const isFlash  = exit === "flash";

  return (
    <div
      style={{
        display: "grid",
        gridTemplateRows: isFading ? "0fr" : "1fr",
        opacity: isFading ? 0 : 1,
        transition: isFading ? "grid-template-rows 420ms ease, opacity 280ms ease" : undefined,
        overflow: "hidden",
        pointerEvents: exit !== "idle" ? "none" : undefined }}
    >
      <div style={{ overflow: "hidden" }} className="relative">
        {selectable && (
          <button
            type="button"
            onClick={() => selection!.toggle(job.id)}
            className={`absolute top-3 left-2.5 z-10 w-5 h-5 rounded border flex items-center justify-center transition-colors ${
              checked
                ? "bg-[var(--brand)] border-[var(--brand)]"
                : "bg-[var(--surface)] border-[var(--border)] hover:border-[var(--brand)]"
            }`}
            aria-label={checked ? "Deselect job" : "Select job"}
          >
            {checked && <CheckCircle2 className="w-3.5 h-3.5 text-[var(--brand-fg)]" strokeWidth={3} />}
          </button>
        )}
        <div
          ref={refSetter}
          role="button"
          tabIndex={0}
          onClick={onCardClick}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onCardClick();
            }
          }}
          className={`transition-all cursor-pointer bg-surface rounded-xl px-[18px] py-[27px] hover:shadow-[var(--shadow-card-hover)] ${
            paneOpen && !isActive ? "opacity-35" : ""
          } ${
            hero ? "border-2 border-[var(--brand)]/30 p-4" : ""
          } ${selectable ? "pl-10" : ""} ${
            isFlash ? "bg-success-subtle" : ""
          } ${savedFlicker ? "jd-saved-flicker" : ""}`}
          style={hero ? undefined : (() => {
            // Never mix a `borderLeft` shorthand with `borderWidth/Style/Color`
            // in one style object — React's style diffing drops the left-side
            // longhands on client re-render (cards lose their left border until
            // a full reload). Use 4-value shorthands for the applied accent.
            const tone = isFlash ? "var(--success)" : checked || isActive ? "var(--brand)" : "var(--border)";
            const applied = !!job.applied_at;
            return {
              borderWidth: applied ? "1px 1px 1px 2px" : "1px",
              borderStyle: "solid",
              borderColor: applied ? `${tone} ${tone} ${tone} var(--success)` : tone,
              boxShadow: checked || isActive ? "0 0 0 3px color-mix(in srgb, var(--brand) 12%, transparent)" : undefined,
            };
          })()}
        >
          <CardActionsContext.Provider value={{ onDismiss, onEdit: () => setShowEdit(true), onToggleStar, starred, pending }}>
            {children}
          </CardActionsContext.Provider>
        </div>
      </div>

      {showEdit && (
        <JobEditModal
          jobId={job.id}
          jobUrl={job.url}
          // Omitted on purpose: board rows no longer carry the JD text, so the
          // modal fetches it for this one job when it opens.
          initialManual={manualJd}
          initialEmail={contactEmail}
          initialHiringMgr={hiringMgr}
          initialCompanyAddress={companyAddress}
          excludeKeywords={excludeKeywords}
          onClose={() => setShowEdit(false)}
          onSaved={(patch) => {
            const wasThin = job.jd_quality === "thin" || job.jd_quality === "unknown";
            const nowFilled = (patch.manual_jd_text?.trim().length ?? 0) >= MANUAL_JD_MIN_CHARS;
            if (wasThin && nowFilled) {
              setSavedFlicker(true);
              setTimeout(() => setSavedFlicker(false), 1900);
            }
            setManualJd(patch.manual_jd_text);
            setContactEmail(patch.contact_email);
            setHiringMgr(patch.hiring_manager);
            setCompanyAddress(patch.company_address);
          }}
        />
      )}
    </div>
  );
}

"use client";

/**
 * Compact detail-pane header — title, meta line, one status chip + subtext
 * line, and the action row (Full analysis · primary action · ⋯ menu).
 *
 * Deliberately does NOT reuse `AnalyzeJobButton`'s navigate-to-analysis-page
 * behaviour: the whole point of the master-detail redesign is staying on the
 * board, so a successful (re-)analyse here just refreshes this panel + the
 * list in place instead of routing away.
 */

import { useState } from "react";
import { Loader2, MoreHorizontal } from "lucide-react";
import { IconButton, MenuItem } from "@/components/ui";
import { markJobApplied, markJobDismissed } from "@/lib/actions/jobs";
import { triggerReanalyze } from "@/lib/analyzeJob";
import { JobEditModal } from "../JobEditModal";
import { Distance } from "../FeedCards";
import { PIPELINE_STATE_META, TONE_CLASSES } from "../../lib/pipelineState";
import { relativeDate, formatSalary, EMPLOYMENT_CHIP_LABEL } from "../../lib/smartFeedUtils";
import type { BoardJob } from "../../lib/jobFilters";

const TONE_BADGE: Record<string, "green" | "amber" | "red" | "blue" | "gray"> = {
  success: "green", warning: "amber", danger: "red", info: "blue", neutral: "gray",
};

export function DetailHeader({
  job, onClosed, onChanged,
}: {
  job: BoardJob;
  /** Called after a dismiss/archive so the parent can clear ?job= and drop the card. */
  onClosed: () => void;
  /** Called after any mutation that should refresh both this panel and the list. */
  onChanged: () => void;
}) {
  const [showEdit, setShowEdit] = useState(false);
  const [analysing, setAnalysing]     = useState(false);
  const [applying, setApplying]       = useState(false);
  const [menuOpen, setMenuOpen]       = useState(false);
  const [error, setError]             = useState<string | null>(null);

  const meta = PIPELINE_STATE_META[job.pipelineState ?? "discovered"];
  const badgeVariant = TONE_BADGE[meta.tone] ?? "gray";

  async function onDismiss() {
    try { await markJobDismissed(job.id, job.profile_id); onClosed(); }
    catch { setError("Could not archive this job."); }
  }

  async function onApply() {
    if (applying) return;
    setApplying(true);
    try {
      window.open(job.url, "_blank", "noopener,noreferrer");
      await markJobApplied(job.id, job.profile_id);
      onChanged();
    } catch {
      setError("Could not mark this job as applied.");
    } finally {
      setApplying(false);
    }
  }

  async function runAnalyze(override?: "thin_jd" | "initial_gate" | "all") {
    if (analysing) return;
    setAnalysing(true); setError(null);
    try {
      const url = override ? `/api/jobs/${job.id}/analyze?override=${override}` : `/api/jobs/${job.id}/analyze`;
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `Failed (${res.status})`);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Analysis failed to start");
    } finally {
      setAnalysing(false);
    }
  }

  async function onReanalyze() {
    if (analysing) return;
    setAnalysing(true); setError(null);
    try {
      await triggerReanalyze(job.id);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not re-analyse");
    } finally {
      setAnalysing(false);
    }
  }

  const isApplied = !!job.applied_at;
  const needsJd   = job.pipelineState === "needs_jd";
  const failed    = job.progress.latest_run_status === "failed";
  const notAnalysed = !job.progress.has_analysis && !needsJd && !failed;
  const belowGate  = job.pipelineState === "below_final" || job.pipelineState === "below_initial" || job.pipelineState === "role_mismatch";
  const analysisHref = job.progress.latest_run_id ? `/jobs/${job.id}/analyze/${job.progress.latest_run_id}` : null;

  return (
    <div className="border-b border-border px-8 pt-4 pb-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
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
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            <span className={`inline-flex items-center gap-[5px] text-[12px] font-semibold px-[10px] py-[3px] rounded-full border ${TONE_CLASSES[meta.tone]?.pill ?? ""}`}>
              <span className={`inline-block w-[6px] h-[6px] rounded-full ${TONE_CLASSES[meta.tone]?.dot ?? ""}`} />
              {meta.label}
            </span>
            <span className="text-label text-text-2">{statusSubtext(job)}</span>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {analysisHref && (
            <a href={analysisHref}
              className="inline-flex items-center px-[14px] py-[8px] rounded-[9px] text-[13px] font-semibold whitespace-nowrap bg-[#eef3ff] text-[#2563eb] border border-[#cdddff] hover:bg-[#e2ecff] transition-colors"
              title="Opens the full analysis page"
            >Full analysis ↗</a>
          )}

          {isApplied ? (
            <span className="inline-flex items-center px-[14px] py-[8px] rounded-[9px] text-[13px] font-semibold bg-[var(--green-soft)] text-[var(--green)]">✓ Applied</span>
          ) : needsJd ? (
            <button type="button" onClick={() => setShowEdit(true)}
              className="inline-flex items-center px-[14px] py-[8px] rounded-[9px] text-[13px] font-semibold whitespace-nowrap bg-[var(--brand)] text-white hover:opacity-90 transition-opacity"
            >Add job description</button>
          ) : failed ? (
            <button type="button" onClick={() => runAnalyze()} disabled={analysing}
              className="inline-flex items-center px-[14px] py-[8px] rounded-[9px] text-[13px] font-semibold whitespace-nowrap bg-[var(--brand)] text-white hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              {analysing ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : null}
              {analysing ? "Analysing…" : "Retry analysis"}
            </button>
          ) : notAnalysed ? (
            <button type="button" onClick={() => runAnalyze()} disabled={analysing}
              className="inline-flex items-center px-[14px] py-[8px] rounded-[9px] text-[13px] font-semibold whitespace-nowrap bg-[var(--brand)] text-white hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              {analysing ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : null}
              {analysing ? "Analysing…" : "Analyse this job"}
            </button>
          ) : belowGate ? (
            <button type="button" onClick={onApply} disabled={applying}
              className="inline-flex items-center px-[14px] py-[8px] rounded-[9px] text-[13px] font-semibold whitespace-nowrap bg-[var(--brand)] text-white hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              {applying ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : null}
              {applying ? "Applying…" : "Apply anyway"}
            </button>
          ) : (
            <button type="button" onClick={onApply} disabled={applying}
              className="inline-flex items-center px-[14px] py-[8px] rounded-[9px] text-[13px] font-semibold whitespace-nowrap bg-[var(--brand)] text-white hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              {applying ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : null}
              {applying ? "Applying…" : "Apply now"}
            </button>
          )}

          <div className="relative">
            <IconButton onClick={() => setMenuOpen((v) => !v)} aria-label="More actions" size="lg" variant="outline" icon={<MoreHorizontal className="w-3.5 h-3.5" />} />
            {menuOpen && (
              <div className="absolute right-0 top-full mt-1 z-30 min-w-[180px] rounded-md border border-border bg-surface shadow-lg py-1 text-label" onMouseLeave={() => setMenuOpen(false)}>
                <MenuItem onClick={() => { setMenuOpen(false); setShowEdit(true); }}>Edit job description…</MenuItem>
                {job.progress.has_analysis && job.progress.latest_run_id && (
                  <MenuItem onClick={() => { setMenuOpen(false); onReanalyze(); }} disabled={analysing}>Re-analyse</MenuItem>
                )}
                {(job.pipelineState === "below_initial" || job.pipelineState === "role_mismatch") && (
                  <MenuItem onClick={() => { setMenuOpen(false); runAnalyze("all"); }} disabled={analysing}>Force full analysis</MenuItem>
                )}
                <MenuItem onClick={() => { setMenuOpen(false); window.open(job.url, "_blank", "noopener,noreferrer"); }}>View job posting ↗</MenuItem>
                <MenuItem onClick={() => { setMenuOpen(false); onDismiss(); }} danger>Dismiss</MenuItem>
              </div>
            )}
          </div>
        </div>
      </div>

      {error && <p className="text-label text-red-600 mt-2">{error}</p>}

      {showEdit && (
        <JobEditModal
          jobId={job.id}
          jobUrl={job.url}
          originalJd={job.description ?? ""}
          initialManual={job.manual_jd_text ?? null}
          initialEmail={job.contact_email ?? null}
          initialHiringMgr={job.hiring_manager ?? null}
          initialCompanyAddress={job.company_address ?? null}
          onClose={() => setShowEdit(false)}
          onSaved={() => { setShowEdit(false); onChanged(); }}
        />
      )}
    </div>
  );
}

function statusSubtext(job: BoardJob): string {
  const state = job.pipelineState ?? "discovered";
  const parts: string[] = [];
  const hasBothScores = job.initial_ats_score != null && job.tailored_match_score != null && job.initial_ats_score !== job.tailored_match_score;

  if (job.applied_at) {
    parts.push(relativeDate(job.applied_at)?.toLowerCase() ?? "");
  }

  if (state === "applied") {
    if (hasBothScores) parts.push(`ATS ${job.initial_ats_score} → ${job.tailored_match_score}`);
    else if (job.tailored_match_score != null) parts.push(`ATS ${job.tailored_match_score}`);
    else if (job.initial_ats_score != null) parts.push(`ATS ${job.initial_ats_score}`);
    if (job.progress.has_tailored_cv) parts.push("Tailored CV + cover letter sent via listing");
  } else if (state === "ready_to_apply" || state === "ready_to_send") {
    if (hasBothScores) parts.push(`ATS ${job.initial_ats_score} → ${job.tailored_match_score}`);
    else if (job.tailored_match_score != null) parts.push(`ATS ${job.tailored_match_score}`);
    const types = (job.employment_types ?? []).map((t) => EMPLOYMENT_CHIP_LABEL[t] ?? t);
    if (types.length) parts.push(types.join("/"));
    const sal = formatSalary(job);
    if (sal) parts.push(sal);
  } else if (state === "below_final" || state === "below_initial") {
    if (hasBothScores) parts.push(`ATS ${job.initial_ats_score} → ${job.tailored_match_score} tailored`);
    else if (job.initial_ats_score != null) parts.push(`ATS ${job.initial_ats_score}`);
    const types = (job.employment_types ?? []).map((t) => EMPLOYMENT_CHIP_LABEL[t] ?? t);
    if (types.length) parts.push(types.join(", "));
    const sal = formatSalary(job);
    if (sal) parts.push(sal);
    if (!job.progress.has_cover_letter) parts.push("cover letter skipped");
  } else if (state === "role_mismatch") {
    if (job.initial_ats_score != null) parts.push(`ATS ${job.initial_ats_score}`);
    parts.push("analysis stopped after scoring");
    if (job.contact_email) parts.push("contact email on file");
  } else if (state === "analysing") {
    parts.push("Analysis in progress…");
  } else if (state === "needs_jd") {
    const types = (job.employment_types ?? []).map((t) => EMPLOYMENT_CHIP_LABEL[t] ?? t);
    if (types.length) parts.push(types.join(", "));
    const descLen = (job.description ?? "").length;
    if (descLen > 0) parts.push(`only ${descLen} characters scraped`);
  } else {
    if (job.progress.has_analysis) {
      if (job.initial_ats_score != null) parts.push(`ATS ${job.initial_ats_score}`);
    }
    const types = (job.employment_types ?? []).map((t) => EMPLOYMENT_CHIP_LABEL[t] ?? t);
    if (types.length) parts.push(types.join("/"));
    const sal = formatSalary(job);
    if (sal) parts.push(sal);
  }
  if (job.contact_email && (state === "below_final" || state === "below_initial")) {
    parts.push("\u2709 contact email on file");
  }
  return parts.filter(Boolean).join(" · ");
}

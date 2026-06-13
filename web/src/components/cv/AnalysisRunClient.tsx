"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { AlertTriangle, Zap, Loader2, StopCircle } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { MIN_INITIAL_ATS }      from "@/lib/atsThresholds";
import { cancelAnalysisRun }    from "@/lib/actions";
import { JdAnalysisCard }       from "@/components/cv/JdAnalysisCard";
import { CvJdMatchingCard }     from "@/components/cv/CvJdMatchingCard";
import { AtsScoreCard }         from "@/components/cv/AtsScoreCard";
import { FeasibilityCard }      from "@/components/cv/FeasibilityCard";
import { RecommendationsCard }  from "@/components/cv/RecommendationsCard";
import { TailoredCvCard }       from "@/components/cv/TailoredCvCard";
import { TailoredScoreCard }    from "@/components/cv/TailoredScoreCard";
import { QualityFlagsCard }     from "@/components/cv/QualityFlagsCard";
import { AnalyzeJobButton }     from "@/components/cv/AnalyzeJobButton";

interface AnalysisRunRow {
  id:                          string;
  job_id?:                     string;
  status:                      "pending" | "running" | "completed" | "failed";
  step_status:                 Record<string, string>;
  /** Auto cover-letter outcome (migration 040). NULL = not attempted yet.
   *  See cv-backend auto_cover_letter.py for the value domain:
   *    'triggered' | 'skipped:<reason>' | 'failed:<reason>' */
  cover_letter_status:         string | null;
  jd_analysis_result:          Record<string, unknown> | null;
  cv_jd_matching_result:       Record<string, unknown> | null;
  ats_scoring_result:          Record<string, unknown> | null;
  input_recommendations:       Record<string, unknown> | null;
  keyword_feasibility:         Record<string, unknown> | null;
  ai_recommendations:          string | null;
  tailored_cv_storage_path:    string | null;
  tailored_pdf_storage_path:   string | null;
  tailored_ats_scoring_result: Record<string, unknown> | null;
  injected_keywords:           {
    injected?:             string[];
    failed_to_inject?:     string[];
    filtered_as_non_skill?: string[];
    honest_gaps?:          string[];
    fabricated?:           string[];
  } | null;
  match_score:                 number | null;
  tailored_match_score:        number | null;
  ats_lift:                    number | null;
  quality_flags:               {
    honesty_guard_notes?:        string[];
    pre_filter_dropped_roles?:   string[];
    honesty_risk?:               { risk_level?: string; vertical_months?: number };
  } | null;
  error_message:               string | null;
  jd_text?:                    string;
  ai_provider?:                string | null;
  ai_model?:                   string | null;
  created_at:                  string;
}

interface CoverLetterRow {
  id:           string;
  status:       string;   // 'pending' | 'running' | 'picking' | 'completed' | 'failed'
  completed_at: string | null;
}

interface CategorisedSkills {
  technical?:        string[];
  soft_skills?:      string[];
  domain_knowledge?: string[];
}

interface Props {
  runId:              string;
  initial:            AnalysisRunRow;
  cvLabel?:           string | null;
  cvCharLen?:         number;
  cvCategorisedSkills?: CategorisedSkills | null;
}

// Step labels match cv-magic's AnalysisProgress wording verbatim, plus the
// auto cover-letter step (synthetic — not from step_status JSONB, derived
// from analysis_runs.cover_letter_status + the cover_letters row).
const STEPS: { key: string; label: string }[] = [
  { key: "jd_analysis",           label: "Analysing job description" },
  { key: "cv_jd_matching",        label: "Matching CV to JD" },
  { key: "ats_scoring",           label: "ATS scoring" },
  { key: "input_recommendations", label: "Building recommendations" },
  { key: "keyword_feasibility",   label: "Classifying keyword feasibility" },
  { key: "ai_recommendations",    label: "Generating AI advice" },
  { key: "tailored_cv",           label: "Creating tailored CV" },
];
const COVER_LETTER_STEP = { key: "cover_letter", label: "Generating cover letter" };

type StepState = "pending" | "running" | "completed" | "failed" | "skipped";

function StepRow({
  label, state, scoreBadge, subLabel, trailingNode,
}: {
  label:         string;
  state:         StepState;
  scoreBadge?:   number | null;       // shown inline after ATS scoring step
  subLabel?:     string;              // small italic line under the main label
  trailingNode?: React.ReactNode;     // e.g. "View letter" link
}) {
  const dot =
    state === "completed" ? "bg-green" :
    state === "running"   ? "bg-blue animate-pulse" :
    state === "failed"    ? "bg-red" :
    state === "skipped"   ? "bg-amber-400" :
                            "bg-text-3/30";
  const color =
    state === "running"   ? "text-text" :
    state === "completed" ? "text-text-2" :
    state === "failed"    ? "text-red" :
    state === "skipped"   ? "text-amber-700" :
                            "text-text-3";
  return (
    <div className="flex items-start gap-3 py-2">
      <span className={`w-2 h-2 rounded-full shrink-0 mt-1.5 ${dot} ${state === "running" ? "ring-2 ring-blue/30" : ""}`} />
      <div className="min-w-0 flex-1 flex items-center gap-2 flex-wrap">
        <span className={`text-[13px] ${color}`}>{label}</span>
        {typeof scoreBadge === "number" && state === "completed" && (
          <span className="text-[11px] font-semibold text-[var(--brand)] bg-[#DDF4FF] border border-[var(--brand)]/20 rounded px-1.5 py-0.5 tabular-nums">
            {Math.round(scoreBadge)}%
          </span>
        )}
        {subLabel && (
          <span className="text-[11px] text-text-3 italic w-full">{subLabel}</span>
        )}
      </div>
      {trailingNode}
      <span className="text-[11px] text-text-3 uppercase tracking-wide shrink-0">{state}</span>
    </div>
  );
}

/**
 * Derive the cover-letter step's display state + sub-label from the two
 * sources of truth:
 *   - analysis_runs.cover_letter_status (set by the orchestrator)
 *   - cover_letters.status (set by the generator pipeline)
 */
function deriveCoverLetterStep(
  cls: string | null,
  coverLetter: CoverLetterRow | null,
  runIsTerminal: boolean,
): { state: StepState; subLabel?: string } {
  // Pipeline still running, no decision yet
  if (cls == null) {
    return { state: runIsTerminal ? "pending" : "pending" };
  }
  if (cls === "triggered") {
    if (!coverLetter) return { state: "running", subLabel: "Starting generator…" };
    const s = coverLetter.status;
    if (s === "completed") return { state: "completed" };
    if (s === "failed")    return { state: "failed", subLabel: "Generator failed — check Application pool" };
    if (s === "picking")   return { state: "running", subLabel: "Generating opening variants…" };
    return { state: "running", subLabel: "Drafting in your voice…" };
  }
  if (cls.startsWith("skipped:")) {
    const reason = cls.slice("skipped:".length);
    const human: Record<string, string> = {
      below_gate: "Tailored score below threshold",
      no_voice:   "No writing voice saved yet — add one in Writing voice",
      no_story:   "No stories extracted from your CV yet",
      duplicate:  "A letter for this job already exists",
    };
    return { state: "skipped", subLabel: human[reason] ?? reason };
  }
  if (cls.startsWith("failed:")) {
    return { state: "failed", subLabel: cls.slice("failed:".length) };
  }
  return { state: "pending" };
}

export function AnalysisRunClient({ runId, initial, cvLabel, cvCharLen, cvCategorisedSkills }: Props) {
  const [run, setRun] = useState<AnalysisRunRow>(initial);
  const [coverLetter, setCoverLetter] = useState<CoverLetterRow | null>(null);
  const [showInput, setShowInput] = useState(false);
  const [resuming, setResuming]   = useState(false);
  const [resumeErr, setResumeErr] = useState<string | null>(null);

  // Resume a gate-stopped run in place. The backend reuses the cached
  // jd_analysis / cv_jd_matching / ats_scoring on this same run row and
  // continues from input_recommendations. We optimistically flip status →
  // running + reset the four downstream steps to pending so the existing
  // poll/Realtime effect starts streaming again without a reload.
  async function handleResume() {
    if (!run.job_id || resuming) return;
    setResuming(true);
    setResumeErr(null);
    try {
      const res  = await fetch(`/api/jobs/${run.job_id}/analyze/${runId}/resume`, { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setResumeErr((json.error as string) ?? `Failed (${res.status})`);
        setResuming(false);
        return;
      }
      setRun((prev) => ({
        ...prev,
        status: "running",
        error_message: null,
        step_status: {
          ...prev.step_status,
          input_recommendations: "pending",
          keyword_feasibility:   "pending",
          ai_recommendations:    "pending",
          tailored_cv:           "pending",
        },
      }));
    } catch {
      setResumeErr("Network error — try again.");
    } finally {
      setResuming(false);
    }
  }

  // Refs so the polling interval can read the latest state without
  // restarting the effect each render.
  const statusRef       = useRef(run.status);
  const clsRef          = useRef<string | null>(run.cover_letter_status ?? null);
  const coverLetterRef  = useRef<CoverLetterRow | null>(null);
  statusRef.current      = run.status;
  clsRef.current         = run.cover_letter_status ?? null;
  coverLetterRef.current = coverLetter;

  useEffect(() => {
    const supabase = createClient();
    let active = true;

    /**
     * Stop polling only when EVERYTHING the UI cares about is settled:
     *   - analysis_run is terminal AND
     *   - cover_letter_status is set (any value), AND
     *   - if it's 'triggered', the cover_letters row is itself terminal.
     */
    function settled(): boolean {
      const runTerminal = statusRef.current === "completed" || statusRef.current === "failed";
      if (!runTerminal) return false;
      const cls = clsRef.current;
      if (cls == null) return false;            // outcome not recorded yet
      if (cls !== "triggered") return true;     // skipped:* or failed:* → done
      // 'triggered' — must wait for the cover_letters row to finish
      const cl = coverLetterRef.current;
      return !!cl && (cl.status === "completed" || cl.status === "failed");
    }

    async function fetchOnce() {
      if (settled()) return;

      const { data } = await supabase
        .from("analysis_runs")
        .select("id, job_id, status, step_status, cover_letter_status, jd_analysis_result, cv_jd_matching_result, ats_scoring_result, input_recommendations, keyword_feasibility, ai_recommendations, tailored_cv_storage_path, tailored_pdf_storage_path, tailored_ats_scoring_result, injected_keywords, match_score, tailored_match_score, ats_lift, quality_flags, error_message, jd_text, ai_provider, ai_model, created_at")
        .eq("id", runId)
        .single();
      if (data && active) {
        setRun(data as AnalysisRunRow);
      }

      // If the auto-letter was triggered, poll the cover_letters row tied
      // to this run so we can show its 'running → completed/failed' state.
      const cls = (data as AnalysisRunRow | null)?.cover_letter_status ?? null;
      if (active && cls === "triggered") {
        const { data: cl } = await supabase
          .from("cover_letters")
          .select("id, status, completed_at")
          .eq("analysis_run_id", runId)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (active && cl) setCoverLetter(cl as CoverLetterRow);
      }
    }

    // Initial fetch handles the race where the row was updated between SSR
    // and the moment this client subscribed.
    fetchOnce();

    // Polling fallback every 3s — defensive against Realtime not delivering.
    // Stops on its own once the run reaches a terminal state (see fetchOnce).
    const poll = setInterval(fetchOnce, 3_000);

    // Realtime subscription — instant updates when it works.
    const channel = supabase
      .channel(`analysis_runs:${runId}`)
      .on(
        "postgres_changes",
        {
          event:  "UPDATE",
          schema: "public",
          table:  "analysis_runs",
          filter: `id=eq.${runId}`,
        },
        (payload) => {
          // RLS at the broadcast layer already restricts to the user's rows.
          if (active) setRun((prev) => ({ ...prev, ...(payload.new as Partial<AnalysisRunRow>) }));
        },
      )
      .subscribe();

    return () => {
      active = false;
      clearInterval(poll);
      supabase.removeChannel(channel);
    };
  }, [runId]);

  const isTerminal = run.status === "completed" || run.status === "failed";
  const isActive   = run.status === "pending"   || run.status === "running";
  const [cancelPending, startCancel] = useTransition();

  // Early-stop signal: the orchestrator marks the four downstream steps
  // 'skipped' (not 'pending'/'failed') only when the initial-ATS gate fails
  // and the user hasn't overridden it. tailored_cv === 'skipped' on a
  // completed run is the precise marker — surface a "tailor anyway" CTA.
  const stoppedAtInitialGate =
    run.status === "completed" &&
    run.step_status?.tailored_cv === "skipped" &&
    !!run.job_id;

  // Role-family-aware skill-category labels persisted on the JD analysis
  // (jd_analysis_result.category_labels). Drives the matching card + CV skills
  // summary so a nursing run shows "Clinical Skills" instead of "Technical".
  const catLabels = resolveCatLabels(run.jd_analysis_result);
  const catOrder  = resolveCatOrder(run.jd_analysis_result);

  return (
    <div className="space-y-6">
      {/* Steps */}
      <div className="bg-surface border border-border rounded-md">
        <div className="px-5 py-3 border-b border-border bg-surface-2 flex items-center justify-between gap-3">
          <h2 className="text-[14px] font-semibold text-text">Pipeline steps</h2>
          <div className="flex items-center gap-3">
            <span className={`text-[11px] uppercase tracking-wide ${
              run.status === "failed"  ? "text-red" :
              run.status === "completed" ? "text-green" :
              "text-text-3"
            }`}>
              {run.status}
            </span>
            {/* Stop — only while the run is active (pending/running). Marks
                the run failed so cv-backend stops at its next checkpoint and
                this page updates instantly via Realtime. Tokens for already-
                completed steps are spent; this prevents remaining steps
                (tailoring, cover-letter) from firing. */}
            {isActive && (
              <button
                onClick={() => startCancel(async () => { await cancelAnalysisRun(runId); })}
                disabled={cancelPending}
                className="inline-flex items-center gap-1.5 text-[12px] font-medium text-red-600 hover:text-red-700 border border-red-200 hover:border-red-300 bg-red-50 hover:bg-red-100 rounded-md px-2.5 py-1 transition-colors disabled:opacity-50"
                title="Stop this analysis — prevents remaining AI steps from running"
              >
                {cancelPending
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : <StopCircle className="w-3.5 h-3.5" />
                }
                Stop
              </button>
            )}
            {/* Re-analyse — only once the current run is terminal so we never
                spawn a second pipeline over a live one. Reuses AnalyzeJobButton,
                which marks this run stale, creates a fresh run, and navigates
                to it. */}
            {isTerminal && run.job_id && (
              <AnalyzeJobButton jobId={run.job_id} hasAnalysis />
            )}
          </div>
        </div>
        <div className="px-5 py-3 divide-y divide-border/50">
          {STEPS
            .filter((s) => (run.step_status?.[s.key] ?? "pending") !== "skipped")
            .map((s) => (
            <StepRow
              key={s.key}
              label={s.label}
              state={(run.step_status?.[s.key] ?? "pending") as StepState}
              scoreBadge={s.key === "ats_scoring" ? run.match_score ?? null : null}
            />
          ))}
          {/* Cover-letter step — synthetic, derived from cover_letter_status
              + the cover_letters row. Shows pending until the pipeline
              completes, then 'running' (pulsing blue dot) while the
              generator drafts, then 'completed' / 'failed' / 'skipped'. */}
          {(() => {
            const cl = deriveCoverLetterStep(run.cover_letter_status, coverLetter, isTerminal);
            const trailing = cl.state === "completed" && coverLetter
              ? (
                <a
                  href="/dashboard/applications?status=email"
                  className="text-[11px] font-semibold text-[var(--brand)] hover:underline"
                >
                  View letter →
                </a>
              )
              : null;
            return (
              <StepRow
                key={COVER_LETTER_STEP.key}
                label={COVER_LETTER_STEP.label}
                state={cl.state}
                subLabel={cl.subLabel}
                trailingNode={trailing}
              />
            );
          })()}
        </div>
        {run.error_message && (
          <div className="px-5 py-3 border-t border-border bg-red-light/30 text-[12px] text-red">
            {run.error_message}
          </div>
        )}
        {!isTerminal && (
          <div className="px-5 py-3 border-t border-border bg-surface-2 text-[11px] text-text-3">
            Live — updates stream in via Supabase Realtime.
          </div>
        )}
      </div>

      {/* Initial-gate early-stop — resume the SAME run past the gate. The
          backend reuses the cached JD analysis / matching / scoring and
          continues from recommendations onward, so no early step re-runs. */}
      {stoppedAtInitialGate && (
        <div className="bg-amber-50 border border-amber-200 rounded-md px-5 py-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1">
              <h3 className="text-[13px] font-semibold text-amber-900">
                Tailoring skipped — initial ATS below the gate
              </h3>
              <p className="text-[12px] text-amber-800 mt-1 leading-relaxed">
                {typeof run.match_score === "number"
                  ? `The initial ATS score (${Math.round(run.match_score)}%) is below the ${MIN_INITIAL_ATS}% gate, `
                  : `The initial ATS score is below the ${MIN_INITIAL_ATS}% gate, `}
                so the pipeline stopped before generating a tailored CV to save AI calls.
                You can continue from here — it picks up where it left off and tailors the CV anyway.
              </p>
              <div className="mt-3 flex items-center gap-3">
                <button
                  type="button"
                  onClick={handleResume}
                  disabled={resuming}
                  className="inline-flex items-center gap-1.5 rounded-md bg-amber-600 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-amber-700 disabled:opacity-50 transition-colors"
                  title="Continue this run past the gate and generate the tailored CV (reuses the analysis already done)"
                >
                  {resuming ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
                  {resuming ? "Resuming…" : "Continue & tailor anyway"}
                </button>
                {resumeErr && <span className="text-[11px] text-red">{resumeErr}</span>}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Run details — exactly what the AI saw. Useful for debugging quality. */}
      <div className="bg-surface border border-border rounded-md overflow-hidden">
        <button
          type="button"
          onClick={() => setShowInput((v) => !v)}
          className="w-full px-5 py-3 flex items-center justify-between gap-3 border-b border-border bg-surface-2 hover:bg-surface"
        >
          <div className="flex items-center gap-2">
            <svg
              className={`w-3 h-3 text-text-3 transition-transform ${showInput ? "rotate-90" : ""}`}
              fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7"/>
            </svg>
            <span className="text-[14px] font-semibold text-text">Run details</span>
          </div>
          <div className="flex items-center gap-2 text-[11px] text-text-3 tabular-nums">
            {run.ai_provider && <span>{run.ai_provider}</span>}
            {run.ai_model && <span className="font-mono">{run.ai_model}</span>}
            {typeof run.jd_text === "string" && (
              <span>JD: {run.jd_text.length.toLocaleString()} chars</span>
            )}
            {typeof cvCharLen === "number" && (
              <span>CV: {cvCharLen.toLocaleString()} chars</span>
            )}
          </div>
        </button>

        {showInput && (
          <div className="px-5 py-4 space-y-4 text-[12px]">
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-text-2">
              <dt className="text-text-3">Provider</dt>
              <dd className="font-mono text-text">{run.ai_provider ?? "—"}</dd>
              <dt className="text-text-3">Model</dt>
              <dd className="font-mono text-text">{run.ai_model ?? "—"}</dd>
              <dt className="text-text-3">CV used</dt>
              <dd className="text-text">
                {cvLabel ?? "(deleted)"}{" "}
                {typeof cvCharLen === "number" && (
                  <span className="text-text-3">· {cvCharLen.toLocaleString()} chars</span>
                )}
              </dd>
              <dt className="text-text-3">JD length</dt>
              <dd className="text-text tabular-nums">
                {typeof run.jd_text === "string" ? run.jd_text.length.toLocaleString() : "—"} chars
              </dd>
            </dl>

            {run.jd_text && (
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-widest text-text-3 mb-1.5">
                  Exact JD text sent to the AI
                </div>
                <pre className="bg-surface-2 border border-border rounded p-3 text-[12px] text-text-2 leading-relaxed max-h-96 overflow-y-auto whitespace-pre-wrap break-words">
                  {run.jd_text}
                </pre>
                <p className="text-[11px] text-text-3 mt-1.5">
                  To verify cv-magic parity: copy this text, paste into a standalone
                  chat with <span className="font-mono">{run.ai_model ?? "the same model"}</span>,
                  use cv-magic&apos;s JD-analysis prompt, and compare outputs.
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* CV skills — shown independently of the JD, mirrors cv-magic order. */}
      {cvCategorisedSkills && <CvSkillsSummary skills={cvCategorisedSkills} label={cvLabel ?? null} catLabels={catLabels} catOrder={catOrder} />}

      {/* Pipeline output cards — order matches cv-magic: scoring impact
          appears BEFORE the tailored CV markdown so the user sees the
          'so what?' before scrolling through the rewrite. */}
      {run.jd_analysis_result && (
        <JdAnalysisCard data={run.jd_analysis_result as Record<string, unknown>} />
      )}
      {run.cv_jd_matching_result && (
        <CvJdMatchingCard data={run.cv_jd_matching_result as Record<string, unknown>} catLabels={catLabels} catOrder={catOrder} />
      )}
      {run.ats_scoring_result && (
        <AtsScoreCard data={run.ats_scoring_result as Record<string, unknown>} />
      )}
      {run.keyword_feasibility && (
        <FeasibilityCard data={run.keyword_feasibility as Record<string, unknown>} />
      )}
      {run.ai_recommendations && (
        <RecommendationsCard markdown={run.ai_recommendations} />
      )}
      {run.quality_flags && <QualityFlagsCard flags={run.quality_flags} />}
      {(run.match_score != null || run.tailored_match_score != null) && (
        <TailoredScoreCard
          beforeScore={run.match_score}
          afterScore={run.tailored_match_score}
          lift={run.ats_lift}
          injected={run.injected_keywords?.injected}
          failedToInject={run.injected_keywords?.failed_to_inject}
          filteredAsNonSkill={run.injected_keywords?.filtered_as_non_skill}
          honestGaps={run.injected_keywords?.honest_gaps}
          fabricated={run.injected_keywords?.fabricated}
          structuralReport={
            (run.tailored_ats_scoring_result as { structural_report?: { summary?: { pass?: number; warn?: number; fail?: number } } } | null)?.structural_report
          }
        />
      )}
      {run.tailored_cv_storage_path && (
        <TailoredCvCard
          storagePath={run.tailored_cv_storage_path}
          pdfStoragePath={run.tailored_pdf_storage_path}
          runId={runId}
        />
      )}
    </div>
  );
}

// ── CV skills summary (independent of JD) ───────────────────────────────────

const CAT_ORDER = ["technical", "soft_skills", "domain_knowledge"] as const;
type Cat = (typeof CAT_ORDER)[number];
const CAT_LABEL: Record<Cat, string> = {
  technical:        "Technical",
  soft_skills:      "Soft skills",
  domain_knowledge: "Domain knowledge",
};

// Merge the role-family-aware labels persisted on jd_analysis_result over the
// generic defaults. Runs analysed before the enrichment landed have no
// category_labels and fall back to the defaults.
function resolveCatLabels(jd: Record<string, unknown> | null): Record<string, string> {
  const raw = (jd as { category_labels?: Record<string, string> } | null)?.category_labels;
  if (!raw || typeof raw !== "object") return CAT_LABEL;
  return { ...CAT_LABEL, ...raw };
}

// Role-family-aware display order persisted on jd_analysis_result.category_order
// (headline bucket first, then soft, then the other bucket). Falls back to the
// generic order for runs analysed before the enrichment landed.
function resolveCatOrder(jd: Record<string, unknown> | null): Cat[] {
  const raw = (jd as { category_order?: string[] } | null)?.category_order;
  if (!Array.isArray(raw)) return [...CAT_ORDER];
  const valid = raw.filter(
    (k): k is Cat => k === "technical" || k === "soft_skills" || k === "domain_knowledge",
  );
  return valid.length === 3 ? valid : [...CAT_ORDER];
}

function CvSkillsSummary({
  skills, label, catLabels, catOrder,
}: {
  skills: CategorisedSkills;
  label:  string | null;
  catLabels: Record<string, string>;
  catOrder: Cat[];
}) {
  const totals = catOrder.map((c) => skills[c]?.length ?? 0);
  const total  = totals.reduce((a, b) => a + b, 0);
  if (total === 0) return null;

  return (
    <div className="bg-surface border border-border rounded-md overflow-hidden">
      <div className="px-5 py-3 border-b border-border bg-surface-2 flex items-center justify-between gap-3">
        <h2 className="text-[14px] font-semibold text-text">Your CV — skills by category</h2>
        {label && <span className="text-[11px] text-text-3 truncate">{label}</span>}
      </div>
      <div className="px-5 py-4 space-y-3">
        <div className="flex flex-wrap gap-4 text-[12px]">
          {catOrder.map((cat, i) => (
            <div key={cat} className="flex items-baseline gap-1.5">
              <span className="text-[14px] font-semibold tabular-nums text-text">{totals[i]}</span>
              <span className="text-text-3">{catLabels[cat].toLowerCase()}</span>
            </div>
          ))}
          <div className="ml-auto flex items-baseline gap-1.5">
            <span className="text-[14px] font-semibold tabular-nums text-text">{total}</span>
            <span className="text-text-3">total</span>
          </div>
        </div>
        <div className="space-y-2">
          {catOrder.map((cat) => {
            const items = skills[cat];
            if (!items || items.length === 0) return null;
            return (
              <div key={cat}>
                <h3 className="text-[10px] font-semibold uppercase tracking-widest text-text-3 mb-1">
                  {catLabels[cat]} <span className="font-normal">({items.length})</span>
                </h3>
                <div className="flex flex-wrap gap-1">
                  {items.map((s) => (
                    <span key={s} className="text-[11px] font-mono px-1.5 py-0.5 rounded border bg-[#DDF4FF] text-[var(--brand)] border-[var(--brand)]/20">
                      {s}
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

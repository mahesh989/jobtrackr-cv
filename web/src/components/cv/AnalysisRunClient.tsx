"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { JdAnalysisCard }       from "@/components/cv/JdAnalysisCard";
import { CvJdMatchingCard }     from "@/components/cv/CvJdMatchingCard";
import { AtsScoreCard }         from "@/components/cv/AtsScoreCard";
import { FeasibilityCard }      from "@/components/cv/FeasibilityCard";
import { RecommendationsCard }  from "@/components/cv/RecommendationsCard";
import { TailoredCvCard }       from "@/components/cv/TailoredCvCard";
import { TailoredScoreCard }    from "@/components/cv/TailoredScoreCard";

interface AnalysisRunRow {
  id:                          string;
  status:                      "pending" | "running" | "completed" | "failed";
  step_status:                 Record<string, string>;
  jd_analysis_result:          Record<string, unknown> | null;
  cv_jd_matching_result:       Record<string, unknown> | null;
  ats_scoring_result:          Record<string, unknown> | null;
  input_recommendations:       Record<string, unknown> | null;
  keyword_feasibility:         Record<string, unknown> | null;
  ai_recommendations:          string | null;
  tailored_cv_storage_path:    string | null;
  tailored_ats_scoring_result: Record<string, unknown> | null;
  injected_keywords:           {
    injected?:         string[];
    failed_to_inject?: string[];
    honest_gaps?:      string[];
    fabricated?:       string[];
  } | null;
  match_score:                 number | null;
  tailored_match_score:        number | null;
  ats_lift:                    number | null;
  error_message:               string | null;
  jd_text?:                    string;
  ai_provider?:                string | null;
  ai_model?:                   string | null;
  created_at:                  string;
}

interface Props {
  runId:     string;
  initial:   AnalysisRunRow;
  cvLabel?:  string | null;
  cvCharLen?: number;
}

const STEPS: { key: string; label: string }[] = [
  { key: "jd_analysis",           label: "JD analysis" },
  { key: "cv_jd_matching",        label: "CV ↔ JD matching" },
  { key: "ats_scoring",           label: "ATS scoring" },
  { key: "input_recommendations", label: "Input recommendations" },
  { key: "keyword_feasibility",   label: "Keyword feasibility" },
  { key: "ai_recommendations",    label: "AI recommendations" },
  { key: "tailored_cv",           label: "Tailored CV" },
];

function StepRow({ label, state }: { label: string; state: string }) {
  const dot =
    state === "completed" ? "bg-green" :
    state === "running"   ? "bg-blue animate-pulse" :
    state === "failed"    ? "bg-red" :
                            "bg-text-3/30";
  const color =
    state === "running"   ? "text-text" :
    state === "completed" ? "text-text-2" :
    state === "failed"    ? "text-red" :
                            "text-text-3";
  return (
    <div className="flex items-center gap-3 py-2">
      <span className={`w-2 h-2 rounded-full shrink-0 ${dot}`} />
      <span className={`text-[13px] ${color}`}>{label}</span>
      <span className="text-[11px] text-text-3 ml-auto uppercase tracking-wide">{state}</span>
    </div>
  );
}

export function AnalysisRunClient({ runId, initial, cvLabel, cvCharLen }: Props) {
  const [run, setRun] = useState<AnalysisRunRow>(initial);
  const [showInput, setShowInput] = useState(false);

  // Ref so the polling interval can read the latest status without restarting
  // the effect each render.
  const statusRef = useRef(run.status);
  statusRef.current = run.status;

  useEffect(() => {
    const supabase = createClient();
    let active = true;

    async function fetchOnce() {
      // Stop fetching once the run is terminal.
      if (statusRef.current === "completed" || statusRef.current === "failed") return;
      const { data } = await supabase
        .from("analysis_runs")
        .select("id, status, step_status, jd_analysis_result, cv_jd_matching_result, ats_scoring_result, input_recommendations, keyword_feasibility, ai_recommendations, tailored_cv_storage_path, tailored_ats_scoring_result, injected_keywords, match_score, tailored_match_score, ats_lift, error_message, jd_text, ai_provider, ai_model, created_at")
        .eq("id", runId)
        .single();
      if (data && active) {
        setRun(data as AnalysisRunRow);
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

  return (
    <div className="space-y-6">
      {/* Steps */}
      <div className="bg-surface border border-border rounded-md">
        <div className="px-5 py-3 border-b border-border bg-surface-2 flex items-center justify-between">
          <h2 className="text-[14px] font-semibold text-text">Pipeline steps</h2>
          <span className={`text-[11px] uppercase tracking-wide ${
            run.status === "failed"  ? "text-red" :
            run.status === "completed" ? "text-green" :
            "text-text-3"
          }`}>
            {run.status}
          </span>
        </div>
        <div className="px-5 py-3 divide-y divide-border/50">
          {STEPS.map((s) => (
            <StepRow key={s.key} label={s.label} state={run.step_status?.[s.key] ?? "pending"} />
          ))}
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

      {/* Pipeline output cards — rendered in step order so the user can scan
          top-to-bottom and see the AI's reasoning unfold. */}
      {run.jd_analysis_result && (
        <JdAnalysisCard data={run.jd_analysis_result as Record<string, unknown>} />
      )}
      {run.cv_jd_matching_result && (
        <CvJdMatchingCard data={run.cv_jd_matching_result as Record<string, unknown>} />
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
      {run.tailored_cv_storage_path && (
        <TailoredCvCard storagePath={run.tailored_cv_storage_path} />
      )}
      {(run.match_score != null || run.tailored_match_score != null) && (
        <TailoredScoreCard
          beforeScore={run.match_score}
          afterScore={run.tailored_match_score}
          lift={run.ats_lift}
          injected={run.injected_keywords?.injected}
          failedToInject={run.injected_keywords?.failed_to_inject}
          honestGaps={run.injected_keywords?.honest_gaps}
          fabricated={run.injected_keywords?.fabricated}
          structuralReport={
            (run.tailored_ats_scoring_result as { structural_report?: { summary?: { pass?: number; warn?: number; fail?: number } } } | null)?.structural_report
          }
        />
      )}
    </div>
  );
}

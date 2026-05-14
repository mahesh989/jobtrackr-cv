"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

interface AnalysisRunRow {
  id:                  string;
  status:              "pending" | "running" | "completed" | "failed";
  step_status:         Record<string, string>;
  jd_analysis_result:  Record<string, unknown> | null;
  error_message:       string | null;
  created_at:          string;
}

interface Props {
  runId:   string;
  initial: AnalysisRunRow;
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

export function AnalysisRunClient({ runId, initial }: Props) {
  const [run, setRun] = useState<AnalysisRunRow>(initial);

  useEffect(() => {
    const supabase = createClient();
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
          // Server-side validation (RLS) already restricts to the user's own rows.
          setRun((prev) => ({ ...prev, ...(payload.new as Partial<AnalysisRunRow>) }));
        },
      )
      .subscribe();

    return () => {
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

      {/* Step 1 result — JSON for now; Phase 6 replaces with proper cards */}
      {run.jd_analysis_result && (
        <div className="bg-surface border border-border rounded-md">
          <div className="px-5 py-3 border-b border-border bg-surface-2">
            <h2 className="text-[14px] font-semibold text-text">JD analysis</h2>
            <p className="text-[12px] text-text-3 mt-0.5">
              Structured output extracted from the job description by the AI step.
            </p>
          </div>
          <pre className="px-5 py-4 text-[12px] text-text-2 leading-relaxed overflow-x-auto whitespace-pre-wrap">
            {JSON.stringify(run.jd_analysis_result, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

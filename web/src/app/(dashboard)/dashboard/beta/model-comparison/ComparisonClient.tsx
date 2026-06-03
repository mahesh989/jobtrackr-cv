"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EvalRunRow } from "@/lib/cvBackend";

type BetaCvVersion = {
  id: string;
  label: string;
  is_active: boolean;
  created_at: string;
};

type ComparisonRun = {
  id: string;
  provider: "openai" | "anthropic";
  model: string;
  label: string;
};

// Pricing per 1M tokens (as of 2026-06-03)
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "gpt-4o":           { input: 5,     output: 15 },
  "gpt-4-turbo":      { input: 10,    output: 30 },
  "gpt-5":            { input: 40,    output: 160 },
  "gpt-5.1":          { input: 40,    output: 160 },
  "gpt-5.2":          { input: 40,    output: 160 },
  "gpt-5.5":          { input: 40,    output: 160 },
  "claude-opus-4-7":  { input: 15,    output: 75 },
  "claude-opus-4-8":  { input: 15,    output: 75 },
  "claude-sonnet-4-6": { input: 3,    output: 15 },
};

const POLL_INTERVAL_MS = 3000;

const OPENAI_MODELS = [
  "gpt-4o",
  "gpt-4-turbo",
  "gpt-5",
  "gpt-5.1",
  "gpt-5.2",
  "gpt-5.5",
];

const ANTHROPIC_MODELS = [
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-sonnet-4-6",
];

function estimateCost(model: string, cvLength: number, jdLength: number): { input: number; output: number; total: number } {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return { input: 0, output: 0, total: 0 };

  const inputTokens = Math.ceil((cvLength + jdLength) / 4);
  const outputTokens = Math.ceil(inputTokens * 0.5);

  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;

  return {
    input: inputCost,
    output: outputCost,
    total: inputCost + outputCost,
  };
}

type TriggerResult = {
  writer_variant: string;
  eval_run_id?: string;
  error?: string;
};

type RunResponse = {
  experiment_id: string;
  scorer_variant: string;
  provider: string;
  model: string | null;
  triggers: TriggerResult[];
};

export default function ComparisonClient({
  cvVersions,
  connectedProviders,
}: {
  cvVersions: BetaCvVersion[];
  connectedProviders: string[];
}) {
  const [jdText, setJdText]         = useState("");
  const [jdLabel, setJdLabel]       = useState("");
  const [vertical, setVertical]     = useState<string>("it");
  const [cvMode, setCvMode]         = useState<"version" | "paste">(cvVersions.length > 0 ? "version" : "paste");
  const [cvVersionId, setCvVersionId] = useState<string>(
    cvVersions.find((c) => c.is_active)?.id ?? cvVersions[0]?.id ?? "",
  );
  const [pastedCv, setPastedCv]     = useState("");
  const [cvLabel, setCvLabel]       = useState("");
  const [writer, setWriter]         = useState<string>("w8_verified");
  const [selectedOpenAI, setSelectedOpenAI] = useState<Set<string>>(new Set(["gpt-4o"]));
  const [selectedAnthropic, setSelectedAnthropic] = useState<Set<string>>(new Set(["claude-opus-4-8"]));

  const [running, setRunning]       = useState(false);
  const [runError, setRunError]     = useState<string | null>(null);
  const [experimentId, setExperimentId] = useState<string | null>(null);
  const [results, setResults]       = useState<Record<string, EvalRunRow>>({});
  const [evalRunIds, setEvalRunIds] = useState<Record<string, string>>({});
  const [estimatedCosts, setEstimatedCosts] = useState<Record<string, { input: number; output: number; total: number }>>({});

  const pollTimers = useRef<Record<string, ReturnType<typeof setInterval>>>({});

  const stopPolling = useCallback((evalRunId: string) => {
    const t = pollTimers.current[evalRunId];
    if (t) {
      clearInterval(t);
      delete pollTimers.current[evalRunId];
    }
  }, []);

  const startPolling = useCallback((evalRunId: string) => {
    if (pollTimers.current[evalRunId]) return;
    const tick = async () => {
      try {
        const res = await fetch(`/api/eval/run/${evalRunId}`, { cache: "no-store" });
        if (!res.ok) return;
        const row = (await res.json()) as EvalRunRow;
        setResults((prev) => ({ ...prev, [evalRunId]: row }));
        if (row.status === "completed" || row.status === "failed") {
          stopPolling(evalRunId);
        }
      } catch {
        /* swallow */
      }
    };
    void tick();
    pollTimers.current[evalRunId] = setInterval(tick, POLL_INTERVAL_MS);
  }, [stopPolling]);

  useEffect(() => {
    const timers = pollTimers.current;
    return () => {
      for (const id of Object.keys(timers)) {
        const t = timers[id];
        if (t) clearInterval(t);
      }
    };
  }, []);

  const canRun = useMemo(() => {
    if (running) return false;
    if (jdText.trim().length < 50) return false;
    if (cvMode === "paste"   && pastedCv.trim().length < 50) return false;
    if (cvMode === "version" && !cvVersionId) return false;
    if (connectedProviders.length === 0) return false;
    if (selectedOpenAI.size === 0 && selectedAnthropic.size === 0) return false;
    return true;
  }, [running, jdText, cvMode, pastedCv, cvVersionId, connectedProviders, selectedOpenAI, selectedAnthropic]);

  const onRun = async () => {
    setRunning(true);
    setRunError(null);
    setResults({});
    setEvalRunIds({});
    setEstimatedCosts({});
    setExperimentId(null);

    const cvText = (pastedCv ?? "").trim();
    const cvSource = cvLabel || (cvMode === "paste" ? "paste" : null);

    // Validation: either paste must be substantial, or a version must be selected.
    if (cvMode === "paste" && cvText.length < 50) {
      setRunError("Pasted CV text is too short (min 50 chars)");
      setRunning(false);
      return;
    }
    if (cvMode === "version" && !cvVersionId) {
      setRunError("Select a CV version");
      setRunning(false);
      return;
    }

    const runs: ComparisonRun[] = [];
    let id = 0;
    for (const model of Array.from(selectedOpenAI)) {
      runs.push({
        id: `openai_${id++}`,
        provider: "openai",
        model,
        label: `OpenAI — ${model}`,
      });
    }
    id = 0;
    for (const model of Array.from(selectedAnthropic)) {
      runs.push({
        id: `anthropic_${id++}`,
        provider: "anthropic",
        model,
        label: `Anthropic — ${model}`,
      });
    }

    if (runs.length === 0) {
      setRunError("Select at least one model");
      setRunning(false);
      return;
    }

    const expId = crypto.randomUUID();
    const newEvalRunIds: Record<string, string> = {};
    const costs: Record<string, { input: number; output: number; total: number }> = {};

    // CV length unknown in version mode (server resolves it); use 3500 chars as
    // a typical estimate so the cost line still shows a reasonable ballpark.
    const cvLengthEstimate = cvText.length || 3500;
    for (const run of runs) {
      costs[run.id] = estimateCost(run.model, cvLengthEstimate, jdText.length);
    }
    setEstimatedCosts(costs);

    const triggers = await Promise.all(
      runs.map(async (run) => {
        try {
          const payload: Record<string, unknown> = {
            jd_text:         jdText,
            jd_label:        jdLabel || undefined,
            vertical:        vertical || undefined,
            cv_source:       cvSource ?? undefined,
            writer_variants: [writer],
            scorer_variant:  "s1_current",
            experiment_id:   expId,
            iteration:       1,
            provider:        run.provider,
            ai_model:        run.model,
          };
          if (cvMode === "paste") {
            payload.cv_text = cvText;
          } else {
            payload.cv_version_id = cvVersionId;
          }

          const res = await fetch("/api/eval/run", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });

          if (!res.ok) {
            const body = await res.json();
            throw new Error(typeof body.error === "string" ? body.error : `HTTP ${res.status}`);
          }

          const body = (await res.json()) as RunResponse;
          const evalRunId = body.triggers[0]?.eval_run_id;
          if (evalRunId) {
            newEvalRunIds[run.id] = evalRunId;
            return { run, evalRunId };
          } else {
            throw new Error(body.triggers[0]?.error ?? "No eval_run_id returned");
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { run, error: msg };
        }
      }),
    );

    setExperimentId(expId);
    setEvalRunIds(newEvalRunIds);

    for (const [runId, evalRunId] of Object.entries(newEvalRunIds)) {
      startPolling(evalRunId);
    }

    setRunning(false);

    const errors = triggers.filter((t) => "error" in t && t.error).map((t) => `${t.run.label}: ${t.error}`);
    if (errors.length > 0) {
      setRunError(errors.join("; "));
    }
  };

  return (
    <div className="space-y-6">
      <section className="bg-bg-2 border border-border rounded-lg p-4 space-y-4">
        <h2 className="text-[14px] font-semibold text-text">Model Comparison: OpenAI vs Anthropic</h2>
        <p className="text-[12px] text-text-3">
          Run a single CV + JD through multiple models. Select which OpenAI and Anthropic models to test. Estimated cost shown during analysis.
        </p>

        {/* JD Input */}
        <div>
          <div className="text-[11px] font-semibold text-text-2 mb-1.5">Job Description</div>
          <textarea
            value={jdText}
            onChange={(e) => setJdText(e.target.value)}
            rows={4}
            className="w-full font-mono text-[12px] border border-border rounded-md px-3 py-2 bg-bg text-text"
            placeholder="Paste job description…"
          />
        </div>

        {/* JD Label */}
        <div>
          <div className="text-[11px] font-semibold text-text-2 mb-1.5">JD Label (optional)</div>
          <input
            type="text"
            value={jdLabel}
            onChange={(e) => setJdLabel(e.target.value)}
            placeholder="e.g., Backend Engineer @ TechCorp"
            className="w-full text-[12px] border border-border rounded-md px-3 py-2 bg-bg text-text"
          />
        </div>

        {/* CV Selection */}
        <div>
          <div className="text-[11px] font-semibold text-text-2 mb-1.5">CV Source</div>
          <div className="flex gap-2 mb-2">
            <label className="flex items-center gap-1.5 text-[12px]">
              <input
                type="radio"
                name="cvMode"
                value="version"
                checked={cvMode === "version"}
                onChange={() => setCvMode("version")}
              />
              From Uploaded
            </label>
            <label className="flex items-center gap-1.5 text-[12px]">
              <input
                type="radio"
                name="cvMode"
                value="paste"
                checked={cvMode === "paste"}
                onChange={() => setCvMode("paste")}
              />
              Paste Text
            </label>
          </div>

          {cvMode === "version" && (
            <select
              value={cvVersionId}
              onChange={(e) => setCvVersionId(e.target.value)}
              className="text-[12px] border border-border rounded-md px-2 py-1.5 bg-bg text-text w-full"
            >
              <option value="">Select a CV…</option>
              {cvVersions.map((cv) => (
                <option key={cv.id} value={cv.id}>
                  {cv.label} {cv.is_active ? "(Active)" : ""}
                </option>
              ))}
            </select>
          )}

          {cvMode === "paste" && (
            <textarea
              value={pastedCv}
              onChange={(e) => setPastedCv(e.target.value)}
              rows={6}
              className="w-full font-mono text-[12px] border border-border rounded-md px-3 py-2 bg-bg text-text mt-2"
              placeholder="Paste CV text here…"
            />
          )}
        </div>

        {/* Vertical */}
        <div>
          <div className="text-[11px] font-semibold text-text-2 mb-1.5">Vertical</div>
          <select
            value={vertical}
            onChange={(e) => setVertical(e.target.value)}
            className="text-[12px] border border-border rounded-md px-2 py-1.5 bg-bg text-text w-full"
          >
            {["it", "nursing", "cleaner", "admin", "master", "other"].map((v) => (
              <option key={v} value={v}>
                {v.charAt(0).toUpperCase() + v.slice(1)}
              </option>
            ))}
          </select>
        </div>

        {/* Writer */}
        <div>
          <div className="text-[11px] font-semibold text-text-2 mb-1.5">Writer Variant</div>
          <select
            value={writer}
            onChange={(e) => setWriter(e.target.value)}
            className="text-[12px] border border-border rounded-md px-2 py-1.5 bg-bg text-text w-full"
          >
            <option value="w1_current">W1 — Current Production</option>
            <option value="w8_verified">W8+ — Integrated + Verification</option>
            <option value="w8_critique">W8++ — Integrated + Critique</option>
          </select>
        </div>

        {/* Model Selection */}
        <div className="grid grid-cols-2 gap-4 border-t border-border pt-4">
          <div>
            <div className="text-[11px] font-semibold text-text-2 mb-2">OpenAI Models</div>
            <div className="space-y-1 max-h-40 overflow-y-auto">
              {OPENAI_MODELS.map((model) => (
                <label key={model} className="flex items-center gap-2 text-[12px]">
                  <input
                    type="checkbox"
                    checked={selectedOpenAI.has(model)}
                    onChange={(e) => {
                      const next = new Set(selectedOpenAI);
                      if (e.target.checked) next.add(model); else next.delete(model);
                      setSelectedOpenAI(next);
                    }}
                  />
                  <span>{model}</span>
                </label>
              ))}
            </div>
          </div>

          <div>
            <div className="text-[11px] font-semibold text-text-2 mb-2">Anthropic Models</div>
            <div className="space-y-1">
              {ANTHROPIC_MODELS.map((model) => (
                <label key={model} className="flex items-center gap-2 text-[12px]">
                  <input
                    type="checkbox"
                    checked={selectedAnthropic.has(model)}
                    onChange={(e) => {
                      const next = new Set(selectedAnthropic);
                      if (e.target.checked) next.add(model); else next.delete(model);
                      setSelectedAnthropic(next);
                    }}
                  />
                  <span>{model}</span>
                </label>
              ))}
            </div>
          </div>
        </div>

        {/* Run Button */}
        <div className="flex items-center gap-3">
          <button
            onClick={onRun}
            disabled={!canRun}
            className="gh-btn gh-btn-blue text-[12px] px-4 py-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {running ? `Running ${selectedOpenAI.size + selectedAnthropic.size} analyses…` : `Compare Models (${selectedOpenAI.size + selectedAnthropic.size})`}
          </button>
          {experimentId && (
            <span className="text-[11px] text-text-3 font-mono">exp: {experimentId.slice(0, 8)}…</span>
          )}
          {runError && <span className="text-[11px] text-[#CF222E]">{runError}</span>}
        </div>
      </section>

      {/* Results Grid */}
      {Object.keys(evalRunIds).length > 0 && (
        <section>
          <h3 className="text-[12px] font-semibold text-text mb-3">Results</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {(
              [
                ...Array.from(selectedOpenAI).map((model) => ({ model, provider: "openai" as const })),
                ...Array.from(selectedAnthropic).map((model) => ({ model, provider: "anthropic" as const })),
              ] as Array<{ model: string; provider: "openai" | "anthropic" }>
            ).map(({ model, provider }, idx) => {
                const run = { id: `${provider}_${idx}`, provider, model, label: `${provider} — ${model}` };
                const evalRunId = evalRunIds[run.id];
                const row = evalRunId ? results[evalRunId] : undefined;
                const cost = estimatedCosts[run.id];

                return (
                  <div
                    key={run.id}
                    className="bg-bg-2 border border-border rounded-lg p-4 space-y-3"
                  >
                    <div>
                      <div className="text-[12px] font-semibold text-text">{run.label}</div>
                      {cost && (
                        <div className="text-[11px] text-text-3 mt-0.5">
                          Est. cost: <span className="font-mono">${cost.total.toFixed(2)}</span>
                        </div>
                      )}
                    </div>

                    {!evalRunId && (
                      <div className="text-[11px] text-text-3">Queued…</div>
                    )}

                    {evalRunId && !row && (
                      <div className="text-[11px] text-text-3 animate-pulse">Running…</div>
                    )}

                    {row && (
                      <div className="space-y-2 text-[11px]">
                        <div>
                          <span className="text-text-3">Status:</span>{" "}
                          <span
                            className={
                              row.status === "completed"
                                ? "text-[#2da44e]"
                                : row.status === "failed"
                                  ? "text-[#CF222E]"
                                  : "text-text-3"
                            }
                          >
                            {row.status}
                          </span>
                        </div>

                        {row.status === "completed" && row.auto_metrics && (() => {
                          const m = row.auto_metrics as Record<string, number | string | null>;
                          return (
                          <>
                            <div className="border-t border-border pt-2 space-y-1">
                              <div>
                                <span className="text-text-3">Initial ATS:</span> {row.initial_ats ?? 0}%
                              </div>
                              <div>
                                <span className="text-text-3">Final ATS:</span> {row.final_ats ?? 0}%
                              </div>
                              <div>
                                <span className="text-text-3">ATS Lift:</span>{" "}
                                <span className={row.ats_lift != null && row.ats_lift > 0 ? "text-[#2da44e]" : ""}>
                                  {row.ats_lift != null && row.ats_lift > 0 ? "+" : ""}
                                  {row.ats_lift ?? 0}%
                                </span>
                              </div>
                              <div>
                                <span className="text-text-3">Injected:</span> {String(m.injected_count ?? 0)}
                              </div>
                              <div>
                                <span className="text-text-3">Fabricated:</span>{" "}
                                {String(m.fabricated_count ?? 0)}
                              </div>
                              <div>
                                <span className="text-text-3">Ungrounded:</span>{" "}
                                {String(m.ungrounded_count ?? 0)}
                              </div>
                              <div>
                                <span className="text-text-3">Word Count:</span>{" "}
                                {String(m.tailored_word_count ?? 0)}
                              </div>
                            </div>

                            {row.tailored_md && (
                              <button
                                onClick={() => {
                                  const text = row.tailored_md || "";
                                  void navigator.clipboard.writeText(text);
                                }}
                                className="text-[11px] text-blue-500 hover:underline"
                              >
                                Copy Tailored MD
                              </button>
                            )}
                          </>
                          );
                        })()}

                        {row.status === "failed" && row.error && (
                          <div className="text-[#CF222E] text-[10px] border border-[#CF222E] rounded p-2">
                            {row.error.slice(0, 200)}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
        </section>
      )}
    </div>
  );
}

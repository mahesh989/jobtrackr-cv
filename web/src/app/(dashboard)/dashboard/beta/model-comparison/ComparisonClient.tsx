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

const POLL_INTERVAL_MS = 3000;

const RUNS: ComparisonRun[] = [
  { id: "openai_1",    provider: "openai",    model: "gpt-4o",              label: "OpenAI #1 (GPT-4o)" },
  { id: "openai_2",    provider: "openai",    model: "gpt-4o",              label: "OpenAI #2 (GPT-4o)" },
  { id: "anthropic_1", provider: "anthropic", model: "claude-opus-4-7",     label: "Anthropic #1 (Claude Opus 4.7)" },
  { id: "anthropic_2", provider: "anthropic", model: "claude-opus-4-7",     label: "Anthropic #2 (Claude Opus 4.7)" },
];

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

  const [running, setRunning]       = useState(false);
  const [runError, setRunError]     = useState<string | null>(null);
  const [experimentId, setExperimentId] = useState<string | null>(null);
  const [results, setResults]       = useState<Record<string, EvalRunRow>>({});
  const [evalRunIds, setEvalRunIds] = useState<Record<string, string>>({});

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
    return true;
  }, [running, jdText, cvMode, pastedCv, cvVersionId, connectedProviders]);

  const onRun = async () => {
    setRunning(true);
    setRunError(null);
    setResults({});
    setEvalRunIds({});
    setExperimentId(null);

    let cvText = (pastedCv ?? "").trim();
    let cvSource = cvLabel || null;

    if (!cvText) {
      if (cvMode === "version" && cvVersionId) {
        try {
          const res = await fetch(`/api/cv-versions/${cvVersionId}`, { cache: "no-store" });
          if (res.ok) {
            const cv = (await res.json()) as { cv_text?: string; label?: string };
            cvText = (cv.cv_text as string) ?? "";
            cvSource ??= (cv.label as string) ?? `cv:${cvVersionId.slice(0, 8)}`;
          }
        } catch {
          setRunError("Could not load CV");
          setRunning(false);
          return;
        }
      }
    } else {
      cvSource ??= "paste";
    }

    if (cvText.length < 50) {
      setRunError("CV text is too short");
      setRunning(false);
      return;
    }

    const expId = crypto.randomUUID();

    const newEvalRunIds: Record<string, string> = {};

    // Fan out to all 4 runs in parallel
    const triggers = await Promise.all(
      RUNS.map(async (run) => {
        try {
          const payload = {
            jd_text:         jdText,
            jd_label:        jdLabel || undefined,
            vertical:        vertical || undefined,
            cv_text:         cvText,
            cv_source:       cvSource,
            writer_variants: [writer],
            scorer_variant:  "s1_current",
            experiment_id:   expId,
            iteration:       1,
            provider:        run.provider,
            ai_model:        run.model,
          };

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

    // Check for errors
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
          Run a single CV + JD through 4 analyses: 2 with OpenAI (GPT-4o) and 2 with Anthropic (Claude Opus 4.7).
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

          {cvLabel && cvMode === "paste" && (
            <input
              type="text"
              value={cvLabel}
              onChange={(e) => setCvLabel(e.target.value)}
              placeholder="Label this CV (optional)"
              className="w-full text-[12px] border border-border rounded-md px-3 py-2 bg-bg text-text mt-2"
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

        {/* Run Button */}
        <div className="flex items-center gap-3">
          <button
            onClick={onRun}
            disabled={!canRun}
            className="gh-btn gh-btn-blue text-[12px] px-4 py-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {running ? "Running 4 analyses…" : "Compare Models"}
          </button>
          {experimentId && (
            <span className="text-[11px] text-text-3 font-mono">exp: {experimentId.slice(0, 8)}…</span>
          )}
          {runError && <span className="text-[11px] text-[#CF222E]">{runError}</span>}
        </div>
      </section>

      {/* Results Grid */}
      {Object.keys(evalRunIds).length > 0 && (
        <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {RUNS.map((run) => {
            const evalRunId = evalRunIds[run.id];
            const row = evalRunId ? results[evalRunId] : undefined;

            return (
              <div
                key={run.id}
                className="bg-bg-2 border border-border rounded-lg p-4 space-y-3"
              >
                <div className="text-[12px] font-semibold text-text">{run.label}</div>

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
                      <span className={row.status === "completed" ? "text-[#2da44e]" : row.status === "failed" ? "text-[#CF222E]" : "text-text-3"}>
                        {row.status}
                      </span>
                    </div>

                    {row.status === "completed" && row.auto_metrics && (
                      <>
                        <div className="border-t border-border pt-2 space-y-1">
                          <div><span className="text-text-3">Initial ATS:</span> {row.initial_ats}%</div>
                          <div><span className="text-text-3">Final ATS:</span> {row.final_ats}%</div>
                          <div><span className="text-text-3">ATS Lift:</span> <span className={row.ats_lift > 0 ? "text-[#2da44e]" : ""}>{row.ats_lift > 0 ? "+" : ""}{row.ats_lift}%</span></div>
                          <div><span className="text-text-3">Injected:</span> {row.auto_metrics.injected_count}</div>
                          <div><span className="text-text-3">Fabricated:</span> {row.auto_metrics.fabricated_count}</div>
                          <div><span className="text-text-3">Ungrounded:</span> {row.auto_metrics.ungrounded_count}</div>
                          <div><span className="text-text-3">Word Count:</span> {row.auto_metrics.tailored_word_count}</div>
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
                    )}

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
        </section>
      )}
    </div>
  );
}

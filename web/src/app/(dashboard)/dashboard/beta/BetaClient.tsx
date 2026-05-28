"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EvalRunRow } from "@/lib/cvBackend";

// ─── Variant catalogues ──────────────────────────────────────────────────────
// Mark `available: false` for variants not yet wired on the backend.
// Removing the false flag turns them on once their writer/scorer is registered.

type VariantOpt = { id: string; label: string; available: boolean; note?: string };

const WRITERS: VariantOpt[] = [
  { id: "w1_current",     label: "W1 — Current Production", available: true },
  { id: "w2_general",     label: "W2 — Generalised (de-biased)", available: true },
  { id: "w3_composition", label: "W3 — Composition (universal + pack + seniority)", available: true },
  { id: "w4_chat",        label: "W4 — Chat Single-Call", available: true },
  { id: "w5_surfacing",   label: "W5 — Lexical Surfacing (grounded, ATS-optimised)", available: true },
  { id: "w6_general",     label: "W6 — Re-engineered W1 (general, research-informed)", available: true },
  { id: "w7_converged",   label: "W7 — Convergence (W6 prompt + W3 gates)", available: true },
];

const SCORERS: VariantOpt[] = [
  { id: "s1_current",       label: "S1 — Current ATS (50/35/15)", available: true },
  { id: "s2_grounded",      label: "S2 — Grounded (only CV-traceable keywords)", available: true },
  { id: "s5_ats_readiness", label: "S5 — ATS Readiness (parseability + grounded coverage)", available: true },
  { id: "s3_reweighted",    label: "S3 — Reweighted", available: false, note: "later" },
  { id: "s4_llm",           label: "S4 — LLM-estimated", available: false, note: "later" },
];

const VERTICALS = ["it", "nursing", "cleaner", "admin", "master", "other"] as const;

export type BetaCvVersion = {
  id: string;
  label: string;
  is_active: boolean;
  created_at: string;
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

export default function BetaClient({
  cvVersions,
  connectedProviders,
}: {
  cvVersions: BetaCvVersion[];
  connectedProviders: string[];
}) {
  // ─── Form state ────────────────────────────────────────────────────────
  const [jdText, setJdText]       = useState("");
  const [jdLabel, setJdLabel]     = useState("");
  const [vertical, setVertical]   = useState<string>("it");
  const [cvMode, setCvMode]       = useState<"version" | "paste">(cvVersions.length > 0 ? "version" : "paste");
  const [cvVersionId, setCvVersionId] = useState<string>(
    cvVersions.find((c) => c.is_active)?.id ?? cvVersions[0]?.id ?? "",
  );
  const [pastedCv, setPastedCv]   = useState("");
  const [cvLabel, setCvLabel]     = useState("");
  const [writers, setWriters]     = useState<Set<string>>(new Set(["w1_current"]));
  const [scorer, setScorer]       = useState<string>("s1_current");
  const [provider, setProvider]   = useState<string>("auto");

  // ─── Run state ─────────────────────────────────────────────────────────
  const [running, setRunning]     = useState(false);
  const [runError, setRunError]   = useState<string | null>(null);
  const [experimentId, setExperimentId] = useState<string | null>(null);
  const [triggers, setTriggers]   = useState<TriggerResult[]>([]);
  const [results, setResults]     = useState<Record<string, EvalRunRow>>({});

  // poll-loop housekeeping
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
        if (!res.ok) return;  // keep retrying; transient
        const row = (await res.json()) as EvalRunRow;
        setResults((prev) => ({ ...prev, [evalRunId]: row }));
        if (row.status === "completed" || row.status === "failed") {
          stopPolling(evalRunId);
        }
      } catch {
        /* swallow — next tick will retry */
      }
    };
    void tick();  // immediate first poll so the column updates fast
    pollTimers.current[evalRunId] = setInterval(tick, POLL_INTERVAL_MS);
  }, [stopPolling]);

  useEffect(() => {
    // Capture the ref's current object so the cleanup uses the same map even
    // if the component re-renders (refs are stable; this just satisfies the
    // react-hooks/exhaustive-deps lint without changing behaviour).
    const timers = pollTimers.current;
    return () => {
      for (const id of Object.keys(timers)) {
        const t = timers[id];
        if (t) clearInterval(t);
      }
    };
  }, []);

  // ─── Validation ────────────────────────────────────────────────────────
  const canRun = useMemo(() => {
    if (running) return false;
    if (jdText.trim().length < 50) return false;
    if (writers.size === 0) return false;
    if (cvMode === "paste"   && pastedCv.trim().length < 50) return false;
    if (cvMode === "version" && !cvVersionId) return false;
    if (connectedProviders.length === 0) return false;
    return true;
  }, [running, jdText, writers, cvMode, pastedCv, cvVersionId, connectedProviders]);

  // ─── Run handler ───────────────────────────────────────────────────────
  const onRun = async () => {
    setRunning(true);
    setRunError(null);
    setTriggers([]);
    setResults({});
    setExperimentId(null);

    const payload: Record<string, unknown> = {
      jd_text:         jdText,
      jd_label:        jdLabel || undefined,
      vertical,
      writer_variants: Array.from(writers),
      scorer_variant:  scorer,
      provider:        provider === "auto" ? undefined : provider,
    };
    if (cvMode === "paste") {
      payload.cv_text   = pastedCv;
      payload.cv_source = cvLabel || "paste";
    } else {
      payload.cv_version_id = cvVersionId;
      if (cvLabel) payload.cv_source = cvLabel;
    }

    let res: Response;
    try {
      res = await fetch("/api/eval/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      setRunError(err instanceof Error ? err.message : "Network error");
      setRunning(false);
      return;
    }

    let body: RunResponse | { error: string };
    try { body = await res.json(); }
    catch { body = { error: `HTTP ${res.status}` }; }

    if (!res.ok || !("triggers" in body)) {
      setRunError(("error" in body && body.error) || `HTTP ${res.status}`);
      setRunning(false);
      return;
    }

    setExperimentId(body.experiment_id);
    setTriggers(body.triggers);
    for (const t of body.triggers) {
      if (t.eval_run_id) startPolling(t.eval_run_id);
    }
    setRunning(false);
  };

  // ─── Helpers ───────────────────────────────────────────────────────────
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); }
    catch { /* ignore — older browsers fall back to manual select */ }
  };

  const download = (filename: string, text: string) => {
    const blob = new Blob([text], { type: "text/markdown" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    a.remove(); URL.revokeObjectURL(url);
  };

  const writerLabel = (id: string) =>
    WRITERS.find((w) => w.id === id)?.label ?? id;

  // ─── UI ────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-5">
      {/* Form panel */}
      <section className="bg-surface border border-border rounded-md p-4 space-y-4">
        {connectedProviders.length === 0 && (
          <div className="text-[12px] bg-[#FFF8E1] border border-[#E4C26B] text-[#5C4400] rounded-md px-3 py-2">
            No AI key connected — connect one in Settings → AI keys before running an eval.
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
          <div className="md:col-span-9">
            <label className="block text-[11px] font-semibold text-text-2 mb-1">Job description (paste)</label>
            <textarea
              value={jdText}
              onChange={(e) => setJdText(e.target.value)}
              rows={10}
              className="w-full font-mono text-[12px] border border-border rounded-md px-3 py-2 bg-bg text-text"
              placeholder="Paste the full job description here…"
            />
            <div className="text-[11px] text-text-3 mt-1">{jdText.length.toLocaleString()} chars</div>
          </div>
          <div className="md:col-span-3 space-y-3">
            <div>
              <label className="block text-[11px] font-semibold text-text-2 mb-1">JD label</label>
              <input
                value={jdLabel}
                onChange={(e) => setJdLabel(e.target.value)}
                placeholder="e.g. CAE Data Analyst"
                className="w-full text-[12px] border border-border rounded-md px-2 py-1.5 bg-bg text-text"
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-text-2 mb-1">Vertical</label>
              <select
                value={vertical}
                onChange={(e) => setVertical(e.target.value)}
                className="w-full text-[12px] border border-border rounded-md px-2 py-1.5 bg-bg text-text"
              >
                {VERTICALS.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-text-2 mb-1">Provider</label>
              <select
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
                className="w-full text-[12px] border border-border rounded-md px-2 py-1.5 bg-bg text-text"
              >
                <option value="auto">auto (first available)</option>
                {connectedProviders.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
          </div>
        </div>

        {/* CV source */}
        <div>
          <label className="block text-[11px] font-semibold text-text-2 mb-1">CV source</label>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1.5 text-[12px] text-text">
              <input
                type="radio"
                checked={cvMode === "version"}
                onChange={() => setCvMode("version")}
                disabled={cvVersions.length === 0}
              />
              From cv_versions
            </label>
            <select
              value={cvVersionId}
              onChange={(e) => setCvVersionId(e.target.value)}
              disabled={cvMode !== "version" || cvVersions.length === 0}
              className="text-[12px] border border-border rounded-md px-2 py-1 bg-bg text-text disabled:opacity-50"
            >
              {cvVersions.length === 0 && <option>— no CVs uploaded —</option>}
              {cvVersions.map((cv) => (
                <option key={cv.id} value={cv.id}>
                  {cv.label}{cv.is_active ? " · active" : ""}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1.5 text-[12px] text-text">
              <input
                type="radio"
                checked={cvMode === "paste"}
                onChange={() => setCvMode("paste")}
              />
              Paste CV text
            </label>
            <input
              value={cvLabel}
              onChange={(e) => setCvLabel(e.target.value)}
              placeholder="cv_source label (e.g. wife-nursing)"
              className="text-[12px] border border-border rounded-md px-2 py-1 bg-bg text-text flex-1 min-w-[200px]"
            />
          </div>
          {cvMode === "paste" && (
            <textarea
              value={pastedCv}
              onChange={(e) => setPastedCv(e.target.value)}
              rows={6}
              className="w-full font-mono text-[12px] border border-border rounded-md px-3 py-2 bg-bg text-text mt-2"
              placeholder="Paste CV text here (use this for the nursing CV or any CV not yet uploaded)…"
            />
          )}
        </div>

        {/* Variant pickers */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <div className="text-[11px] font-semibold text-text-2 mb-1.5">Writers</div>
            <div className="flex flex-col gap-1">
              {WRITERS.map((w) => (
                <label
                  key={w.id}
                  className={`flex items-center gap-2 text-[12px] ${w.available ? "text-text" : "text-text-3"}`}
                >
                  <input
                    type="checkbox"
                    disabled={!w.available}
                    checked={writers.has(w.id)}
                    onChange={(e) => {
                      const next = new Set(writers);
                      if (e.target.checked) next.add(w.id); else next.delete(w.id);
                      setWriters(next);
                    }}
                  />
                  <span>{w.label}</span>
                  {!w.available && (
                    <span className="text-[10px] text-text-3 ml-1">({w.note})</span>
                  )}
                </label>
              ))}
            </div>
          </div>
          <div>
            <div className="text-[11px] font-semibold text-text-2 mb-1.5">Scorer (initial + final ATS use this)</div>
            <select
              value={scorer}
              onChange={(e) => setScorer(e.target.value)}
              className="text-[12px] border border-border rounded-md px-2 py-1.5 bg-bg text-text"
            >
              {SCORERS.map((s) => (
                <option key={s.id} value={s.id} disabled={!s.available}>
                  {s.label}{s.available ? "" : ` (${s.note})`}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onRun}
            disabled={!canRun}
            className="gh-btn gh-btn-blue text-[12px] px-3 py-1 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {running ? "Triggering…" : `Run ${writers.size} writer${writers.size === 1 ? "" : "s"}`}
          </button>
          {experimentId && (
            <span className="text-[11px] text-text-3 font-mono">experiment: {experimentId.slice(0, 8)}…</span>
          )}
          {runError && <span className="text-[11px] text-[#CF222E]">{runError}</span>}
        </div>
      </section>

      {/* Results — horizontal scroll of side-by-side columns */}
      {triggers.length > 0 && (
        <section>
          <div className="flex gap-3 overflow-x-auto pb-2">
            {triggers.map((t) => {
              const row = t.eval_run_id ? results[t.eval_run_id] : undefined;
              return (
                <ResultColumn
                  key={t.writer_variant}
                  writerLabel={writerLabel(t.writer_variant)}
                  trigger={t}
                  row={row}
                  onCopy={copy}
                  onDownload={download}
                />
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

// ─── Column ──────────────────────────────────────────────────────────────────

function ResultColumn({
  writerLabel, trigger, row,
  onCopy, onDownload,
}: {
  writerLabel: string;
  trigger: TriggerResult;
  row: EvalRunRow | undefined;
  onCopy: (text: string) => void;
  onDownload: (filename: string, text: string) => void;
}) {
  const status: "trigger_error" | "running" | "completed" | "failed" =
    trigger.error ? "trigger_error"
    : !row ? "running"
    : row.status;

  const lift = row?.ats_lift ?? 0;
  const liftColor =
    lift > 0 ? "text-[#1A7F37]" :
    lift < 0 ? "text-[#CF222E]" : "text-text-3";

  return (
    <div className="min-w-[460px] max-w-[460px] bg-surface border border-border rounded-md flex flex-col">
      {/* Header */}
      <div className="border-b border-border px-3 py-2 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[12px] font-semibold text-text truncate">{writerLabel}</div>
          <div className="text-[10px] font-mono text-text-3 truncate">
            {trigger.eval_run_id ? `${trigger.eval_run_id.slice(0, 8)}…` : "—"}
          </div>
        </div>
        <StatusBadge status={status} />
      </div>

      {/* Trigger-time error (never reached cv-backend) */}
      {status === "trigger_error" && (
        <div className="px-3 py-3 text-[11px] text-[#CF222E] whitespace-pre-wrap">
          {trigger.error}
        </div>
      )}

      {/* Failed in background */}
      {status === "failed" && row?.error && (
        <div className="px-3 py-3 text-[11px] text-[#CF222E] whitespace-pre-wrap">
          {row.error}
        </div>
      )}

      {/* Running placeholder */}
      {status === "running" && (
        <div className="px-3 py-6 text-[12px] text-text-3 text-center">
          Running… (W1 makes ~5 AI calls, expect 30–90s)
        </div>
      )}

      {/* Completed body */}
      {status === "completed" && row && (
        <div className="flex-1 flex flex-col">
          {/* Metric chips */}
          <div className="px-3 py-2 border-b border-border flex flex-wrap gap-1.5 text-[10px]">
            <Chip>ATS {row.initial_ats ?? "—"} → <b className="ml-0.5">{row.final_ats ?? "—"}</b>
              <span className={`ml-1 ${liftColor}`}>
                ({lift >= 0 ? "+" : ""}{lift})
              </span>
            </Chip>
            <MetricChip
              label="struct fail"
              value={(row.structural_summary as { summary?: { fail?: number } } | null)?.summary?.fail ?? 0}
              red
            />
            <MetricChip
              label="struct warn"
              value={(row.structural_summary as { summary?: { warn?: number } } | null)?.summary?.warn ?? 0}
            />
            <MetricChip
              label="ungrounded"
              value={(row.grounding_report as { ungrounded_count?: number } | null)?.ungrounded_count ?? 0}
              red
            />
            <MetricChip
              label="fabricated"
              value={(row.rescore_report as { fabricated_keywords?: string[] } | null)?.fabricated_keywords?.length ?? 0}
              red
            />
            <MetricChip
              label="ms"
              value={Math.round(((row.timings_ms as { total?: number } | null)?.total ?? 0))}
            />
          </div>

          {/* Action buttons */}
          <div className="px-3 py-2 border-b border-border flex gap-2">
            <button
              type="button"
              onClick={() => onCopy(row.tailored_md ?? "")}
              className="gh-btn text-[11px] px-2 py-0.5"
            >Copy md</button>
            <button
              type="button"
              onClick={() => onDownload(`${row.writer_variant}-${row.id.slice(0, 8)}.md`, row.tailored_md ?? "")}
              className="gh-btn text-[11px] px-2 py-0.5"
            >Download .md</button>
          </div>

          {/* Tailored CV — pre/monospace for clean copy/paste */}
          <div className="flex-1 overflow-auto max-h-[480px]">
            <pre className="text-[11px] leading-[1.45] font-mono text-text whitespace-pre-wrap px-3 py-2">
              {row.tailored_md ?? ""}
            </pre>
          </div>

          {/* Diagnostic lists */}
          <DetailsList row={row} />
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === "completed" ? "bg-[#DAFBE1] text-[#1A7F37] border-[#A4DFAE]" :
    status === "running"   ? "bg-[#FFF8E1] text-[#9A6700] border-[#E4C26B]" :
                              "bg-[#FFEBE9] text-[#CF222E] border-[#FDB8C0]";
  return (
    <span className={`text-[10px] border rounded-full px-2 py-0.5 font-medium ${tone}`}>
      {status}
    </span>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="border border-border rounded-md px-1.5 py-0.5 bg-bg text-text">
      {children}
    </span>
  );
}

function MetricChip({ label, value, red }: { label: string; value: number; red?: boolean }) {
  const color = red && value > 0 ? "text-[#CF222E] border-[#FDB8C0] bg-[#FFEBE9]" : "text-text-2 border-border bg-bg";
  return (
    <span className={`border rounded-md px-1.5 py-0.5 ${color}`}>
      {label} <b className="ml-0.5">{value}</b>
    </span>
  );
}

function DetailsList({ row }: { row: EvalRunRow }) {
  const grounding = (row.grounding_report as { ungrounded?: string[] } | null) ?? {};
  const rescore   = (row.rescore_report as {
    injected_keywords?: string[];
    failed_to_inject?: string[];
    honest_gaps?: string[];
    fabricated_keywords?: string[];
  } | null) ?? {};

  const sections: Array<[string, string[] | undefined]> = [
    ["Ungrounded named entities", grounding.ungrounded],
    ["Fabricated (in cannot_inject)", rescore.fabricated_keywords],
    ["Injected (landed)", rescore.injected_keywords],
    ["Failed to inject", rescore.failed_to_inject],
    ["Honest gaps", rescore.honest_gaps],
  ];

  return (
    <div className="border-t border-border px-3 py-2 text-[11px]">
      {sections.map(([label, items]) => (
        <details key={label} className="mb-1">
          <summary className="cursor-pointer text-text-2 hover:text-text">
            {label} <span className="text-text-3">({items?.length ?? 0})</span>
          </summary>
          <div className="text-text mt-1 font-mono break-words">
            {items && items.length > 0 ? items.join(", ") : <span className="text-text-3">none</span>}
          </div>
        </details>
      ))}
    </div>
  );
}

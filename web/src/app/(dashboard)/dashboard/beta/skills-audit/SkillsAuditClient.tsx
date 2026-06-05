"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FullJdJob, RunRow } from "./page";

interface ClassifiedItem {
  item:      string;
  category:  string | null;
  canonical: string | null;
  is_noise:  boolean;
  action:    string;
}

interface AuditedRow extends RunRow {
  classified: ClassifiedItem[];
  loading:    boolean;
  error?:     string;
}

type ReanalyseJobState = "idle" | "queued" | "done" | "failed";

const ACTION_COLORS: Record<string, string> = {
  add_to_lexicon:        "bg-red-50 text-red-700 border-red-200",
  should_be_care_skills: "bg-amber-50 text-amber-700 border-amber-200",
  should_be_stripped:    "bg-gray-100 text-gray-500 border-gray-200 line-through",
  correct:               "bg-green-50 text-green-700 border-green-200",
  correct_technical:     "bg-blue-50 text-blue-600 border-blue-200",
};

const ACTION_LABELS: Record<string, string> = {
  add_to_lexicon:        "add to lexicon",
  should_be_care_skills: "→ Care Skills",
  should_be_stripped:    "strip",
  correct:               "✓",
  correct_technical:     "✓ tech",
};

type FilterMode = "all" | "gaps_only";

export default function SkillsAuditClient({
  rows,
  totalRuns,
  fullJdJobs,
}: {
  rows:        RunRow[];
  totalRuns:   number;
  fullJdJobs:  FullJdJob[];
}) {
  const [audited, setAudited] = useState<AuditedRow[]>(
    rows.map((r) => ({ ...r, classified: [], loading: true }))
  );
  const [filter, setFilter]           = useState<FilterMode>("gaps_only");
  const [expandedRun, setExpandedRun] = useState<string | null>(null);

  // Re-analyse state
  const [reState, setReState]         = useState<Record<string, ReanalyseJobState>>({});
  const [reRunning, setReRunning]     = useState(false);
  const [reQueued, setReQueued]       = useState(0);
  const [reFailed, setReFailed]       = useState(0);
  const [copyDone, setCopyDone]       = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Classify all rows on mount ──────────────────────────────────────────
  useEffect(() => {
    rows.forEach((row, i) => {
      // Skip rows with no Other Skills — nothing to classify
      if (row.other_items.length === 0) {
        setAudited((prev) => {
          const next = [...prev];
          next[i] = { ...next[i], classified: [], loading: false };
          return next;
        });
        return;
      }

      fetch("/api/internal/classify-skills", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ items: row.other_items, vertical: row.lex_vertical }),
      })
        .then((r) => r.json())
        .then((data: { results?: ClassifiedItem[]; error?: string }) => {
          setAudited((prev) => {
            const next = [...prev];
            next[i] = { ...next[i], classified: data.results ?? [], loading: false, error: data.error };
            return next;
          });
        })
        .catch((err: unknown) => {
          setAudited((prev) => {
            const next = [...prev];
            next[i] = { ...next[i], loading: false, error: String(err) };
            return next;
          });
        });
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Summary stats ───────────────────────────────────────────────────────
  const allGaps = audited.flatMap((r) =>
    r.classified.filter((c) => c.action === "add_to_lexicon").map((c) => c.item.toLowerCase())
  );
  const gapFreq = allGaps.reduce<Record<string, number>>((acc, item) => {
    acc[item] = (acc[item] ?? 0) + 1;
    return acc;
  }, {});
  const topGaps = Object.entries(gapFreq).sort((a, b) => b[1] - a[1]).slice(0, 20);

  const totalLoading  = audited.filter((r) => r.loading).length;
  const totalComplete = audited.length - totalLoading;

  const displayRows = filter === "gaps_only"
    ? audited.filter((r) => !r.loading && r.classified.some((c) => c.action !== "correct" && c.action !== "correct_technical"))
    : audited;

  // fullJdJobs comes from the server — all jobs owned by this user with full JDs,
  // regardless of whether they already have a tailored CV in the audit table.

  // ── Re-analyse all ──────────────────────────────────────────────────────
  const startReanalyse = useCallback(async () => {
    if (reRunning || fullJdJobs.length === 0) return;
    setReRunning(true);
    setReQueued(0);
    setReFailed(0);

    const initial: Record<string, ReanalyseJobState> = {};
    for (const job of fullJdJobs) initial[job.job_id] = "queued";
    setReState(initial);

    let queued = 0, failed = 0;

    // Rate limit on analyze route is 20/60s — fire in batches of 5 with a 16s
    // gap between batches so we never exceed ~18 calls per 60s.
    const BATCH_SIZE  = 5;
    const BATCH_DELAY = 16_000; // ms between batches

    for (let i = 0; i < fullJdJobs.length; i += BATCH_SIZE) {
      const batch = fullJdJobs.slice(i, i + BATCH_SIZE);

      await Promise.all(
        batch.map(async (job) => {
          try {
            const res = await fetch(`/api/jobs/${job.job_id}/analyze`, {
              method:  "POST",
              headers: { "Content-Type": "application/json" },
              body:    JSON.stringify({}),
            });
            if (res.ok) {
              queued++;
              setReState((p) => ({ ...p, [job.job_id]: "done" }));
            } else {
              const data = (await res.json().catch(() => ({}))) as { error?: string };
              console.warn(`[skills-audit] failed for ${job.job_title}:`, data.error);
              failed++;
              setReState((p) => ({ ...p, [job.job_id]: "failed" }));
            }
          } catch (err) {
            console.error(`[skills-audit] error for ${job.job_title}:`, err);
            failed++;
            setReState((p) => ({ ...p, [job.job_id]: "failed" }));
          }
        })
      );

      setReQueued(queued);
      setReFailed(failed);

      // Wait before next batch (skip delay after the last batch)
      if (i + BATCH_SIZE < fullJdJobs.length) {
        await new Promise<void>((resolve) => setTimeout(resolve, BATCH_DELAY));
      }
    }

    setReRunning(false);
  }, [reRunning, fullJdJobs]);

  // ── Export gap report ───────────────────────────────────────────────────
  const buildReport = useCallback(() => {
    const allGapsRaw = audited.flatMap((r) =>
      r.classified.filter((c) => c.action === "add_to_lexicon").map((c) => c.item.toLowerCase())
    );
    const freqMap: Record<string, number> = {};
    for (const item of allGapsRaw) freqMap[item] = (freqMap[item] ?? 0) + 1;

    return {
      summary: {
        runs_analysed:                 totalRuns,
        unique_jobs:                   audited.length,
        jobs_with_other_skills_issues: audited.filter((r) =>
          r.classified.some((c) => c.action !== "correct" && c.action !== "correct_technical")
        ).length,
        lexicon_gaps_by_frequency: Object.entries(freqMap).sort((a, b) => b[1] - a[1]),
      },
      // ALL jobs — including those with no issues — so Claude has the full picture
      jobs: audited
        .filter((r) => !r.loading)
        .map((r) => ({
          job_id:               r.job_id,
          job_title:            r.job_title,
          company:              r.company,
          role_family:          r.role_family,
          lex_vertical:         r.lex_vertical,
          // Full Skills section (all lines, not just Other Skills)
          all_skills:           r.all_labels,
          // Other Skills breakdown
          other_skills_raw:     r.other_items,
          needs_lexicon:        r.classified.filter((c) => c.action === "add_to_lexicon").map((c) => c.item),
          should_be_care_skills: r.classified.filter((c) => c.action === "should_be_care_skills").map((c) => c.item),
          should_be_stripped:   r.classified.filter((c) => c.action === "should_be_stripped").map((c) => c.item),
          classified:           r.classified,
        })),
    };
  }, [audited, totalRuns]);

  const downloadReport = useCallback(() => {
    const report = buildReport();
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `skills-audit-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [buildReport]);

  const copyReport = useCallback(() => {
    const report = buildReport();
    void navigator.clipboard.writeText(JSON.stringify(report, null, 2)).then(() => {
      setCopyDone(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopyDone(false), 2500);
    });
  }, [buildReport]);

  const classificationDone = totalLoading === 0 && audited.length > 0;
  const reanalyseAllDone   = reQueued + reFailed === fullJdJobs.length && fullJdJobs.length > 0 && !reRunning;

  return (
    <div className="space-y-5">

      {/* ── Action bar ── */}
      <div className="flex flex-wrap items-center gap-2">

        {/* Re-analyse all */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => void startReanalyse()}
            disabled={reRunning || fullJdJobs.length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded border text-[12px] font-medium transition-colors
              bg-indigo-600 border-indigo-700 text-white hover:bg-indigo-700
              disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {reRunning ? (
              <>
                <span className="inline-block w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Queueing… ({reQueued + reFailed}/{fullJdJobs.length})
              </>
            ) : (
              <>Re-analyse all ({fullJdJobs.length} full-JD jobs)</>
            )}
          </button>

          {/* Per-job status chips */}
          {Object.entries(reState).map(([jid, st]) => {
            const job = fullJdJobs.find((j) => j.job_id === jid);
            const label = job?.job_title ?? jid.slice(0, 8);
            const color =
              st === "done"   ? "bg-green-50 text-green-700 border-green-200" :
              st === "failed" ? "bg-red-50 text-red-700 border-red-200" :
                                "bg-blue-50 text-blue-600 border-blue-100";
            return (
              <span key={jid} className={`px-1.5 py-0.5 rounded border text-[10px] ${color}`}>
                {st === "done" ? "✓" : st === "failed" ? "✗" : "…"} {label}
              </span>
            );
          })}

          {reanalyseAllDone && (
            <span className="text-[11px] text-text-2">
              {reQueued} queued{reFailed > 0 ? `, ${reFailed} failed` : ""} — runs take ~1–2 min each.{" "}
              <button
                onClick={() => window.location.reload()}
                className="underline text-indigo-600 hover:text-indigo-800"
              >
                Refresh page when done
              </button>
            </span>
          )}
        </div>

        <div className="flex-1" />

        {/* Export / copy */}
        <div className="flex items-center gap-1.5">
          <button
            onClick={downloadReport}
            disabled={!classificationDone}
            className="px-2.5 py-1.5 rounded border text-[11px] font-medium transition-colors
              bg-surface border-border text-text hover:bg-surface-hover
              disabled:opacity-40 disabled:cursor-not-allowed"
            title="Download full audit as JSON — all jobs, all skills lines, classified items"
          >
            Export all (JSON)
          </button>
          <button
            onClick={copyReport}
            disabled={!classificationDone}
            className="px-2.5 py-1.5 rounded border text-[11px] font-medium transition-colors
              bg-surface border-border text-text hover:bg-surface-hover
              disabled:opacity-40 disabled:cursor-not-allowed"
            title="Copy full audit to clipboard — paste into Claude to update the lexicon"
          >
            {copyDone ? "Copied!" : "Copy all (paste to Claude)"}
          </button>
        </div>
      </div>

      {/* ── Status bar ── */}
      <div className="flex items-center gap-4 text-[12px] text-text-2">
        <span>
          {totalRuns} runs fetched · {audited.length} with Other Skills · {totalComplete}/{audited.length} classified
        </span>
        {totalLoading > 0 && (
          <span className="text-blue-500 animate-pulse">classifying {totalLoading} remaining…</span>
        )}
        <div className="flex items-center gap-1 ml-auto">
          <button
            onClick={() => setFilter("gaps_only")}
            className={`px-2 py-0.5 rounded border text-[11px] transition-colors ${
              filter === "gaps_only"
                ? "bg-surface border-border text-text font-medium"
                : "border-transparent text-text-3 hover:text-text"
            }`}
          >
            Gaps only
          </button>
          <button
            onClick={() => setFilter("all")}
            className={`px-2 py-0.5 rounded border text-[11px] transition-colors ${
              filter === "all"
                ? "bg-surface border-border text-text font-medium"
                : "border-transparent text-text-3 hover:text-text"
            }`}
          >
            All runs
          </button>
        </div>
      </div>

      {/* ── Top gaps summary ── */}
      {topGaps.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <h2 className="text-[12px] font-semibold text-red-800 mb-2">
            Top lexicon gaps (by frequency across runs)
          </h2>
          <div className="flex flex-wrap gap-1.5">
            {topGaps.map(([item, count]) => (
              <span
                key={item}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded border bg-white border-red-200 text-[11px] text-red-700"
              >
                {item}
                <span className="text-red-400 font-mono">×{count}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* ── Run table ── */}
      <div className="space-y-3">
        {displayRows.length === 0 && !totalLoading && (
          <p className="text-[12px] text-text-3 py-8 text-center">
            {audited.length === 0
              ? `No analysis runs found with Other Skills — check DB query or try "All runs".`
              : `No issues found — all Other Skills items are correctly classified.`}
          </p>
        )}

        {displayRows.map((row) => {
          const gaps    = row.classified.filter((c) => c.action === "add_to_lexicon");
          const reroute = row.classified.filter((c) => c.action === "should_be_care_skills");
          const strips  = row.classified.filter((c) => c.action === "should_be_stripped");
          const correct = row.classified.filter((c) => c.action === "correct" || c.action === "correct_technical");
          const isOpen  = expandedRun === row.run_id;
          const jobRe   = reState[row.job_id];

          return (
            <div key={row.run_id} className="border border-border rounded-lg bg-surface overflow-hidden">
              <button
                className="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-surface-hover transition-colors"
                onClick={() => setExpandedRun(isOpen ? null : row.run_id)}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-medium text-text truncate">{row.job_title || "(untitled)"}</span>
                    <span className="text-[11px] text-text-3 shrink-0">{row.company}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-2 text-text-3 shrink-0 font-mono">
                      {row.role_family}
                    </span>
                    {row.jd_quality === "thin" && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-600 border border-amber-200 shrink-0">
                        thin JD
                      </span>
                    )}
                    {jobRe === "done" && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-50 text-green-700 border border-green-200 shrink-0">
                        re-queued ✓
                      </span>
                    )}
                    {jobRe === "failed" && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-50 text-red-600 border border-red-200 shrink-0">
                        queue failed
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  {row.loading && (
                    <span className="text-[11px] text-blue-400 animate-pulse">classifying…</span>
                  )}
                  {!row.loading && gaps.length > 0 && (
                    <span className="px-1.5 py-0.5 rounded border text-[11px] bg-red-50 text-red-700 border-red-200 font-medium">
                      {gaps.length} gap{gaps.length !== 1 ? "s" : ""}
                    </span>
                  )}
                  {!row.loading && reroute.length > 0 && (
                    <span className="px-1.5 py-0.5 rounded border text-[11px] bg-amber-50 text-amber-700 border-amber-200">
                      {reroute.length} reroute
                    </span>
                  )}
                  {!row.loading && strips.length > 0 && (
                    <span className="px-1.5 py-0.5 rounded border text-[11px] bg-gray-100 text-gray-500 border-gray-200">
                      {strips.length} strip
                    </span>
                  )}
                  {!row.loading && correct.length > 0 && (
                    <span className="text-[11px] text-text-3">{correct.length} ✓</span>
                  )}
                  <svg
                    className={`w-3.5 h-3.5 text-text-3 transition-transform ${isOpen ? "rotate-180" : ""}`}
                    fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </div>
              </button>

              {isOpen && (
                <div className="border-t border-border px-4 py-3 space-y-3">
                  {row.error && (
                    <p className="text-[11px] text-red-600">Error: {row.error}</p>
                  )}

                  {row.classified.length > 0 && (
                    <div>
                      <p className="text-[11px] text-text-3 mb-2 font-medium uppercase tracking-wide">Other Skills items</p>
                      <div className="flex flex-wrap gap-1.5">
                        {row.classified.map((c) => (
                          <span
                            key={c.item}
                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[11px] ${ACTION_COLORS[c.action] ?? ""}`}
                            title={c.canonical ? `canonical: ${c.canonical}` : c.action}
                          >
                            {c.item}
                            {c.action !== "correct" && c.action !== "correct_technical" && (
                              <span className="opacity-60 text-[10px]">{ACTION_LABELS[c.action]}</span>
                            )}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  <div>
                    <p className="text-[11px] text-text-3 mb-1 font-medium uppercase tracking-wide">Full Skills section</p>
                    <div className="space-y-0.5">
                      {Object.entries(row.all_labels).map(([label, items]) => (
                        <div key={label} className="text-[11px] text-text-2">
                          <span className="font-medium text-text">{label}:</span>{" "}
                          {items.join(", ")}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

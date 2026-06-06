"use client";

import { useCallback, useRef, useState } from "react";
import type { FullJdJob, SummaryRow } from "./page";

type ReanalyseJobState = "idle" | "queued" | "done" | "failed";

// ── Jaccard similarity on meaningful tokens (len > 3) ──────────────────────
function jaccardSimilarity(a: string, b: string): number {
  const tokenize = (s: string) =>
    new Set(
      s.toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 3)
    );
  const ta = tokenize(a);
  const tb = tokenize(b);
  const intersection = new Set([...ta].filter((x) => tb.has(x)));
  const union        = new Set([...ta, ...tb]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

// For each row, find its most-similar peer within the same role_family
function buildSimilarityMap(rows: SummaryRow[]): Map<string, { score: number; peer: string }> {
  const result = new Map<string, { score: number; peer: string }>();
  for (let i = 0; i < rows.length; i++) {
    let best = 0;
    let bestPeer = "";
    for (let j = 0; j < rows.length; j++) {
      if (i === j) continue;
      if (rows[i].role_family !== rows[j].role_family) continue;
      const score = jaccardSimilarity(rows[i].career_highlights, rows[j].career_highlights);
      if (score > best) { best = score; bestPeer = rows[j].job_title; }
    }
    if (bestPeer) result.set(rows[i].run_id, { score: best, peer: bestPeer });
  }
  return result;
}

type RoleFilter = "all" | string;

export default function SummaryAuditClient({
  rows,
  fullJdJobs,
}: {
  rows:       SummaryRow[];
  fullJdJobs: FullJdJob[];
}) {
  const [roleFilter,  setRoleFilter]  = useState<RoleFilter>("all");
  const [expandedRun, setExpandedRun] = useState<string | null>(null);
  const [copyDone,    setCopyDone]    = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [reState,   setReState]   = useState<Record<string, ReanalyseJobState>>({});
  const [reRunning, setReRunning] = useState(false);
  const [reQueued,  setReQueued]  = useState(0);
  const [reFailed,  setReFailed]  = useState(0);

  const similarityMap = buildSimilarityMap(rows);

  const roleFamilies = [...new Set(rows.map((r) => r.role_family))].sort();

  const displayRows = roleFilter === "all"
    ? rows
    : rows.filter((r) => r.role_family === roleFilter);

  // ── Re-analyse all ────────────────────────────────────────────────────────
  const startReanalyse = useCallback(async () => {
    if (reRunning || fullJdJobs.length === 0) return;
    setReRunning(true);
    setReQueued(0);
    setReFailed(0);

    let preferredProvider: string | null = null;
    try { preferredProvider = localStorage.getItem("jobtrackr-preferred-provider"); } catch {}

    const initial: Record<string, ReanalyseJobState> = {};
    for (const job of fullJdJobs) initial[job.job_id] = "queued";
    setReState(initial);

    let queued = 0, failed = 0;
    const BATCH_SIZE  = 5;
    const BATCH_DELAY = 16_000;

    for (let i = 0; i < fullJdJobs.length; i += BATCH_SIZE) {
      const batch = fullJdJobs.slice(i, i + BATCH_SIZE);
      await Promise.all(
        batch.map(async (job) => {
          try {
            const res = await fetch(`/api/jobs/${job.job_id}/analyze`, {
              method:  "POST",
              headers: { "Content-Type": "application/json" },
              body:    JSON.stringify(preferredProvider ? { provider: preferredProvider } : {}),
            });
            if (res.ok) {
              queued++;
              setReState((p) => ({ ...p, [job.job_id]: "done" }));
            } else {
              failed++;
              setReState((p) => ({ ...p, [job.job_id]: "failed" }));
            }
          } catch {
            failed++;
            setReState((p) => ({ ...p, [job.job_id]: "failed" }));
          }
        })
      );
      setReQueued(queued);
      setReFailed(failed);
      if (i + BATCH_SIZE < fullJdJobs.length) {
        await new Promise<void>((resolve) => setTimeout(resolve, BATCH_DELAY));
      }
    }
    setReRunning(false);
  }, [reRunning, fullJdJobs]);

  // ── Copy report ───────────────────────────────────────────────────────────
  const copyReport = useCallback(() => {
    const lines: string[] = [
      `Career Highlights Audit — ${displayRows.length} jobs` +
        (roleFilter !== "all" ? ` (${roleFilter} only)` : ""),
      "",
    ];

    for (const row of displayRows) {
      const sim = similarityMap.get(row.run_id);
      const simNote = sim && sim.score > 0.45
        ? `  ⚠ ${Math.round(sim.score * 100)}% similar to "${sim.peer}"`
        : "";
      lines.push(`─── ${row.job_title} · ${row.company} [${row.role_family}]${simNote}`);
      if (row.jd_responsibilities.length > 0) {
        lines.push(`JD responsibilities[0]: ${row.jd_responsibilities[0]}`);
        if (row.jd_responsibilities[1]) {
          lines.push(`JD responsibilities[1]: ${row.jd_responsibilities[1]}`);
        }
      }
      lines.push(`Career Highlights: ${row.career_highlights}`);
      lines.push("");
    }

    void navigator.clipboard.writeText(lines.join("\n")).then(() => {
      setCopyDone(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopyDone(false), 2500);
    });
  }, [displayRows, similarityMap, roleFilter]);

  const highSimCount = displayRows.filter((r) => {
    const s = similarityMap.get(r.run_id);
    return s && s.score > 0.45;
  }).length;

  const reanalyseAllDone =
    reQueued + reFailed === fullJdJobs.length && fullJdJobs.length > 0 && !reRunning;

  return (
    <div className="space-y-5">

      {/* ── Action bar ── */}
      <div className="flex flex-wrap items-center gap-2">

        {/* Re-analyse */}
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
            <>Re-analyse all ({fullJdJobs.length} jobs)</>
          )}
        </button>

        {Object.entries(reState).map(([jid, st]) => {
          const job = fullJdJobs.find((j) => j.job_id === jid);
          const color =
            st === "done"   ? "bg-green-50 text-green-700 border-green-200" :
            st === "failed" ? "bg-red-50 text-red-700 border-red-200" :
                              "bg-blue-50 text-blue-600 border-blue-100";
          return (
            <span key={jid} className={`px-1.5 py-0.5 rounded border text-[10px] ${color}`}>
              {st === "done" ? "✓" : st === "failed" ? "✗" : "…"} {job?.job_title ?? jid.slice(0, 8)}
            </span>
          );
        })}

        {reanalyseAllDone && (
          <span className="text-[11px] text-text-2">
            {reQueued} queued{reFailed > 0 ? `, ${reFailed} failed` : ""} — runs take ~1–2 min.{" "}
            <button
              onClick={() => window.location.reload()}
              className="underline text-indigo-600 hover:text-indigo-800"
            >
              Refresh when done
            </button>
          </span>
        )}

        <div className="flex-1" />

        {/* Role family filter */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => setRoleFilter("all")}
            className={`px-2 py-0.5 rounded border text-[11px] transition-colors ${
              roleFilter === "all"
                ? "bg-surface border-border text-text font-medium"
                : "border-transparent text-text-3 hover:text-text"
            }`}
          >
            All
          </button>
          {roleFamilies.map((rf) => (
            <button
              key={rf}
              onClick={() => setRoleFilter(rf)}
              className={`px-2 py-0.5 rounded border text-[11px] transition-colors ${
                roleFilter === rf
                  ? "bg-surface border-border text-text font-medium"
                  : "border-transparent text-text-3 hover:text-text"
              }`}
            >
              {rf}
            </button>
          ))}
        </div>

        {/* Copy */}
        <button
          onClick={copyReport}
          disabled={displayRows.length === 0}
          className="px-2.5 py-1.5 rounded border text-[11px] font-medium transition-colors
            bg-surface border-border text-text hover:bg-surface-hover
            disabled:opacity-40 disabled:cursor-not-allowed"
          title="Copy all summaries formatted for pasting to Claude"
        >
          {copyDone ? "Copied!" : "Copy all (paste to Claude)"}
        </button>
      </div>

      {/* ── Stats bar ── */}
      <div className="flex items-center gap-4 text-[12px] text-text-2">
        <span>{rows.length} tailored CVs · {displayRows.length} shown</span>
        {highSimCount > 0 && (
          <span className="text-amber-600 font-medium">
            ⚠ {highSimCount} summary pair{highSimCount !== 1 ? "s" : ""} with &gt;45% token overlap
          </span>
        )}
      </div>

      {/* ── Cards ── */}
      <div className="space-y-3">
        {displayRows.length === 0 && (
          <p className="text-[12px] text-text-3 py-8 text-center">
            No tailored CVs found with a Career Highlights section.
          </p>
        )}

        {displayRows.map((row) => {
          const sim    = similarityMap.get(row.run_id);
          const isHigh = sim && sim.score > 0.45;
          const isMed  = sim && sim.score > 0.30 && sim.score <= 0.45;
          const isOpen = expandedRun === row.run_id;
          const jobRe  = reState[row.job_id];

          return (
            <div
              key={row.run_id}
              className={`border rounded-lg bg-surface overflow-hidden ${
                isHigh ? "border-amber-300" : "border-border"
              }`}
            >
              {/* Header */}
              <button
                className="w-full text-left px-4 py-3 flex items-start gap-3 hover:bg-surface-hover transition-colors"
                onClick={() => setExpandedRun(isOpen ? null : row.run_id)}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2 mb-1">
                    <span className="text-[13px] font-medium text-text truncate">{row.job_title || "(untitled)"}</span>
                    <span className="text-[11px] text-text-3 shrink-0">{row.company}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-2 text-text-3 shrink-0 font-mono">
                      {row.role_family}
                    </span>
                    {isHigh && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded border bg-amber-50 text-amber-700 border-amber-300 shrink-0">
                        ⚠ {Math.round(sim.score * 100)}% similar to &ldquo;{sim.peer}&rdquo;
                      </span>
                    )}
                    {isMed && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded border bg-yellow-50 text-yellow-700 border-yellow-200 shrink-0">
                        {Math.round(sim.score * 100)}% overlap
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

                  {/* Career Highlights preview */}
                  <p className="text-[12px] text-text-2 leading-relaxed line-clamp-2">
                    {row.career_highlights || <span className="text-text-3 italic">No Career Highlights found</span>}
                  </p>
                </div>

                <svg
                  className={`w-3.5 h-3.5 text-text-3 transition-transform mt-1 shrink-0 ${isOpen ? "rotate-180" : ""}`}
                  fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </button>

              {/* Expanded */}
              {isOpen && (
                <div className="border-t border-border px-4 py-4 space-y-4">

                  {/* Career Highlights full */}
                  <div>
                    <p className="text-[11px] font-medium text-text-3 uppercase tracking-wide mb-2">
                      Career Highlights (tailored CV)
                    </p>
                    <p className="text-[13px] text-text leading-relaxed bg-surface-2 rounded-md px-3 py-2.5">
                      {row.career_highlights}
                    </p>
                  </div>

                  {/* JD context */}
                  {(row.jd_responsibilities.length > 0 || row.jd_summary) && (
                    <div>
                      <p className="text-[11px] font-medium text-text-3 uppercase tracking-wide mb-2">
                        JD context
                      </p>
                      <div className="space-y-1.5">
                        {row.jd_summary && (
                          <p className="text-[11px] text-text-2 italic">{row.jd_summary}</p>
                        )}
                        {row.jd_responsibilities.slice(0, 4).map((resp, idx) => (
                          <div key={idx} className="flex items-start gap-2 text-[11px] text-text-2">
                            <span className="text-text-3 shrink-0 font-mono mt-0.5">
                              {idx === 0 ? "resp[0]" : `resp[${idx}]`}
                            </span>
                            <span>{resp}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Similarity detail */}
                  {sim && sim.score > 0.20 && (
                    <div>
                      <p className="text-[11px] font-medium text-text-3 uppercase tracking-wide mb-1">
                        Similarity
                      </p>
                      <p className="text-[11px] text-text-2">
                        <span className={sim.score > 0.45 ? "text-amber-600 font-medium" : "text-text-3"}>
                          {Math.round(sim.score * 100)}% token overlap
                        </span>{" "}
                        with &ldquo;{sim.peer}&rdquo; (same role family)
                        {sim.score > 0.45 && " — summaries may be too similar"}
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

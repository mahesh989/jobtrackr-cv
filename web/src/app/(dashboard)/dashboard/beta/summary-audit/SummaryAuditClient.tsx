"use client";

import { useCallback, useRef, useState } from "react";
import type { FullJdJob, SummaryRow } from "./page";

type ReanalyseJobState = "idle" | "queued" | "done" | "failed";

// ── JD setting classifier (mirrors Python _classify_jd_setting) ────────────
type JdSetting =
  | "home_community"
  | "hospital_acute"
  | "ndis_disability"
  | "lifestyle_coordinator"
  | "theatre_cssd"
  | "residential";

function classifyJdSetting(
  responsibilities: string[],
  jobTitle: string,
): JdSetting {
  const resp0    = (responsibilities[0] ?? "").toLowerCase();
  const title    = jobTitle.toLowerCase();
  const combined = resp0 + " " + title;

  if (
    ["theatre cases", "instrument tray", "cssd", "sterile stock",
     "set up consumables", "sterile stock room"].some((kw) => combined.includes(kw))
  ) return "theatre_cssd";

  if (
    ["activities program", "group activities", "organise and schedule",
     "recreational activities", "lifestyle program"].some((kw) => combined.includes(kw)) ||
    ["lifestyle coordinator", "leisure coordinator", "activities coordinator"]
      .some((kw) => title.includes(kw))
  ) return "lifestyle_coordinator";

  if (
    ["ndis", "disability support", "non-verbal participant",
     "acquired brain injury", "high intensity support", "disability worker"]
      .some((kw) => combined.includes(kw))
  ) return "ndis_disability";

  if (
    ["in their home", "in the home", "clients' home", "clients in their home",
     "domestic assistance", "domestic help", "meal preparation",
     "transport to appointments", "transportation to appointments",
     "social outings", "retirement living residents in their homes",
     "home visit", "visit clients"]
      .some((kw) => combined.includes(kw))
  ) return "home_community";

  if (
    ["surgical ward", "orthopaedic", "acute care", "medical department",
     "hospital setting", "hospital staff", "hospital settings", "acute clinical"]
      .some((kw) => combined.includes(kw))
  ) return "hospital_acute";

  return "residential";
}

const SETTING_META: Record<JdSetting, { label: string; color: string; problem: boolean }> = {
  home_community:       { label: "Home/Community",  color: "bg-blue-50 text-blue-700 border-blue-300",     problem: true  },
  hospital_acute:       { label: "Hospital/Acute",  color: "bg-purple-50 text-purple-700 border-purple-300", problem: true  },
  ndis_disability:      { label: "NDIS/Disability", color: "bg-orange-50 text-orange-700 border-orange-300", problem: true  },
  lifestyle_coordinator:{ label: "Lifestyle Coord", color: "bg-green-50 text-green-700 border-green-300",   problem: true  },
  theatre_cssd:         { label: "Theatre/CSSD",    color: "bg-red-50 text-red-700 border-red-300",         problem: true  },
  residential:          { label: "Residential",     color: "bg-gray-50 text-gray-500 border-gray-200",      problem: false },
};

// ── Jaccard similarity ───────────────────────────────────────────────────────
function jaccardSimilarity(a: string, b: string): number {
  const tokenize = (s: string) =>
    new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 3));
  const ta = tokenize(a);
  const tb = tokenize(b);
  const intersection = new Set([...ta].filter((x) => tb.has(x)));
  const union        = new Set([...ta, ...tb]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

function buildSimilarityMap(rows: SummaryRow[]): Map<string, { score: number; peer: string }> {
  const result = new Map<string, { score: number; peer: string }>();
  for (let i = 0; i < rows.length; i++) {
    let best = 0, bestPeer = "";
    for (let j = 0; j < rows.length; j++) {
      if (i === j || rows[i].role_family !== rows[j].role_family) continue;
      const score = jaccardSimilarity(rows[i].career_highlights, rows[j].career_highlights);
      if (score > best) { best = score; bestPeer = rows[j].job_title; }
    }
    if (bestPeer) result.set(rows[i].run_id, { score: best, peer: bestPeer });
  }
  return result;
}

type ViewFilter = "all" | "problematic" | string;

export default function SummaryAuditClient({
  rows,
  fullJdJobs,
}: {
  rows:       SummaryRow[];
  fullJdJobs: FullJdJob[];
}) {
  const [viewFilter,  setViewFilter]  = useState<ViewFilter>("problematic");
  const [expandedRun, setExpandedRun] = useState<string | null>(null);
  const [copyDone,    setCopyDone]    = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [reState,   setReState]   = useState<Record<string, ReanalyseJobState>>({});
  const [reRunning, setReRunning] = useState(false);
  const [reQueued,  setReQueued]  = useState(0);
  const [reFailed,  setReFailed]  = useState(0);

  const similarityMap = buildSimilarityMap(rows);
  const roleFamilies  = [...new Set(rows.map((r) => r.role_family))].sort();

  // Annotate every row with its JD setting
  const annotatedRows = rows.map((r) => ({
    ...r,
    setting: classifyJdSetting(r.jd_responsibilities, r.job_title),
  }));

  const problematicRows = annotatedRows.filter((r) => SETTING_META[r.setting].problem);

  const displayRows =
    viewFilter === "problematic" ? problematicRows :
    viewFilter === "all"         ? annotatedRows :
    annotatedRows.filter((r) => r.role_family === viewFilter);

  // ── Re-analyse ────────────────────────────────────────────────────────────
  const startReanalyse = useCallback(async (jobList: FullJdJob[]) => {
    if (reRunning || jobList.length === 0) return;
    setReRunning(true);
    setReQueued(0);
    setReFailed(0);

    let preferredProvider: string | null = null;
    try { preferredProvider = localStorage.getItem("jobtrackr-preferred-provider"); } catch {}

    const initial: Record<string, ReanalyseJobState> = {};
    for (const job of jobList) initial[job.job_id] = "queued";
    setReState(initial);

    let queued = 0, failed = 0;
    const BATCH_SIZE = 5, BATCH_DELAY = 16_000;

    for (let i = 0; i < jobList.length; i += BATCH_SIZE) {
      const batch = jobList.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(async (job) => {
        try {
          const res = await fetch(`/api/jobs/${job.job_id}/analyze`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify(preferredProvider ? { provider: preferredProvider } : {}),
          });
          if (res.ok) { queued++; setReState((p) => ({ ...p, [job.job_id]: "done" })); }
          else        { failed++; setReState((p) => ({ ...p, [job.job_id]: "failed" })); }
        } catch { failed++; setReState((p) => ({ ...p, [job.job_id]: "failed" })); }
      }));
      setReQueued(queued); setReFailed(failed);
      if (i + BATCH_SIZE < jobList.length)
        await new Promise<void>((resolve) => setTimeout(resolve, BATCH_DELAY));
    }
    setReRunning(false);
  }, [reRunning]);

  // ── Copy report ───────────────────────────────────────────────────────────
  const copyReport = useCallback((jobsToExport: typeof annotatedRows) => {
    const lines: string[] = [
      `Career Highlights Audit — ${jobsToExport.length} jobs` +
        (viewFilter === "problematic" ? " (problematic only)" : ""),
      "",
    ];
    for (const row of jobsToExport) {
      const sim     = similarityMap.get(row.run_id);
      const simNote = sim && sim.score > 0.45 ? `  ⚠ ${Math.round(sim.score * 100)}% similar to "${sim.peer}"` : "";
      const setting = SETTING_META[row.setting].label;
      lines.push(`─── ${row.job_title} · ${row.company} [${row.role_family}] [${setting}]${simNote}`);
      if (row.jd_responsibilities[0]) lines.push(`JD responsibilities[0]: ${row.jd_responsibilities[0]}`);
      if (row.jd_responsibilities[1]) lines.push(`JD responsibilities[1]: ${row.jd_responsibilities[1]}`);
      lines.push(`Career Highlights: ${row.career_highlights}`);
      lines.push("");
    }
    void navigator.clipboard.writeText(lines.join("\n")).then(() => {
      setCopyDone(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopyDone(false), 2500);
    });
  }, [annotatedRows, similarityMap, viewFilter]);

  const reanalyseAllDone = reQueued + reFailed === fullJdJobs.length && fullJdJobs.length > 0 && !reRunning;

  // Problematic jobs that have a matching fullJdJob entry (for re-analyse)
  const problematicFullJdJobs = fullJdJobs.filter((fj) =>
    problematicRows.some((r) => r.job_id === fj.job_id)
  );

  const highSimCount = displayRows.filter((r) => {
    const s = similarityMap.get(r.run_id);
    return s && s.score > 0.45;
  }).length;

  return (
    <div className="space-y-5">

      {/* ── Action bar ── */}
      <div className="flex flex-wrap items-center gap-2">

        {/* Re-analyse problematic */}
        <button
          onClick={() => void startReanalyse(problematicFullJdJobs)}
          disabled={reRunning || problematicFullJdJobs.length === 0}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded border text-[12px] font-medium transition-colors
            bg-orange-600 border-orange-700 text-white hover:bg-orange-700
            disabled:opacity-50 disabled:cursor-not-allowed"
          title="Re-analyse only the problematic (non-residential) jobs"
        >
          {reRunning ? (
            <>
              <span className="inline-block w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              Queueing… ({reQueued + reFailed}/{problematicFullJdJobs.length})
            </>
          ) : (
            <>Re-analyse problematic ({problematicFullJdJobs.length})</>
          )}
        </button>

        {/* Re-analyse all */}
        <button
          onClick={() => void startReanalyse(fullJdJobs)}
          disabled={reRunning || fullJdJobs.length === 0}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded border text-[12px] font-medium transition-colors
            bg-indigo-600 border-indigo-700 text-white hover:bg-indigo-700
            disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Re-analyse all ({fullJdJobs.length})
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
            {reQueued} queued{reFailed > 0 ? `, ${reFailed} failed` : ""} — ~1–2 min each.{" "}
            <button onClick={() => window.location.reload()} className="underline text-indigo-600 hover:text-indigo-800">
              Refresh when done
            </button>
          </span>
        )}

        <div className="flex-1" />

        {/* View filters */}
        <div className="flex items-center gap-1">
          {[
            { key: "problematic", label: `Problematic (${problematicRows.length})` },
            { key: "all",         label: `All (${annotatedRows.length})` },
            ...roleFamilies.map((rf) => ({ key: rf, label: rf })),
          ].map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setViewFilter(key)}
              className={`px-2 py-0.5 rounded border text-[11px] transition-colors ${
                viewFilter === key
                  ? "bg-surface border-border text-text font-medium"
                  : "border-transparent text-text-3 hover:text-text"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Copy */}
        <button
          onClick={() => copyReport(displayRows)}
          disabled={displayRows.length === 0}
          className="px-2.5 py-1.5 rounded border text-[11px] font-medium transition-colors
            bg-surface border-border text-text hover:bg-surface-hover
            disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {copyDone ? "Copied!" : "Copy (paste to Claude)"}
        </button>
      </div>

      {/* ── Stats bar ── */}
      <div className="flex flex-wrap items-center gap-4 text-[12px] text-text-2">
        <span>{annotatedRows.length} total · {problematicRows.length} problematic · {displayRows.length} shown</span>
        {highSimCount > 0 && (
          <span className="text-amber-600 font-medium">⚠ {highSimCount} pairs &gt;45% token overlap</span>
        )}
        {/* Setting breakdown */}
        <div className="flex flex-wrap gap-1 ml-auto">
          {(Object.entries(SETTING_META) as [JdSetting, typeof SETTING_META[JdSetting]][])
            .filter(([, m]) => m.problem)
            .map(([setting, meta]) => {
              const count = annotatedRows.filter((r) => r.setting === setting).length;
              if (!count) return null;
              return (
                <span key={setting} className={`px-1.5 py-0.5 rounded border text-[10px] ${meta.color}`}>
                  {meta.label}: {count}
                </span>
              );
            })}
        </div>
      </div>

      {/* ── Cards ── */}
      <div className="space-y-2">
        {displayRows.length === 0 && (
          <p className="text-[12px] text-text-3 py-8 text-center">
            No {viewFilter === "problematic" ? "problematic" : ""} jobs found.
          </p>
        )}

        {displayRows.map((row) => {
          const sim     = similarityMap.get(row.run_id);
          const isHigh  = sim && sim.score > 0.45;
          const isMed   = sim && sim.score > 0.30 && sim.score <= 0.45;
          const isOpen  = expandedRun === row.run_id;
          const jobRe   = reState[row.job_id];
          const settingMeta = SETTING_META[row.setting];
          const isProblem   = settingMeta.problem;

          return (
            <div
              key={row.run_id}
              className={`border rounded-lg bg-surface overflow-hidden ${
                isProblem && isHigh ? "border-amber-300" :
                isProblem           ? "border-orange-200" :
                                      "border-border"
              }`}
            >
              <button
                className="w-full text-left px-4 py-3 flex items-start gap-3 hover:bg-surface-hover transition-colors"
                onClick={() => setExpandedRun(isOpen ? null : row.run_id)}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5 mb-1">
                    <span className="text-[13px] font-medium text-text truncate">{row.job_title || "(untitled)"}</span>
                    <span className="text-[11px] text-text-3 shrink-0">{row.company}</span>

                    {/* Setting badge */}
                    <span className={`text-[10px] px-1.5 py-0.5 rounded border shrink-0 font-medium ${settingMeta.color}`}>
                      {settingMeta.label}
                    </span>

                    {/* Similarity badge */}
                    {isHigh && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded border bg-amber-50 text-amber-700 border-amber-300 shrink-0">
                        ⚠ {Math.round(sim.score * 100)}% sim
                      </span>
                    )}
                    {isMed && !isHigh && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded border bg-yellow-50 text-yellow-700 border-yellow-200 shrink-0">
                        {Math.round(sim.score * 100)}% sim
                      </span>
                    )}

                    {jobRe === "done"   && <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-50 text-green-700 border border-green-200 shrink-0">re-queued ✓</span>}
                    {jobRe === "failed" && <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-50 text-red-600 border border-red-200 shrink-0">queue failed</span>}
                  </div>

                  {/* resp[0] preview */}
                  {row.jd_responsibilities[0] && (
                    <p className="text-[10px] text-text-3 mb-1 truncate">
                      <span className="font-mono mr-1">resp[0]</span>{row.jd_responsibilities[0]}
                    </p>
                  )}

                  {/* Career Highlights preview */}
                  <p className="text-[12px] text-text-2 leading-relaxed line-clamp-2">
                    {row.career_highlights || <span className="italic">No Career Highlights found</span>}
                  </p>
                </div>

                <svg
                  className={`w-3.5 h-3.5 text-text-3 transition-transform mt-1 shrink-0 ${isOpen ? "rotate-180" : ""}`}
                  fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </button>

              {isOpen && (
                <div className="border-t border-border px-4 py-4 space-y-4">

                  {/* Problem flag */}
                  {isProblem && (
                    <div className={`rounded px-3 py-2 text-[11px] border ${settingMeta.color}`}>
                      <span className="font-semibold">Setting mismatch: </span>
                      JD is <strong>{settingMeta.label}</strong> but candidate CV is residential aged care.
                      The bridge phrase should appear in Career Highlights S1.
                    </div>
                  )}

                  {/* Career Highlights */}
                  <div>
                    <p className="text-[11px] font-medium text-text-3 uppercase tracking-wide mb-2">Career Highlights</p>
                    <p className="text-[13px] text-text leading-relaxed bg-surface-2 rounded-md px-3 py-2.5">
                      {row.career_highlights}
                    </p>
                  </div>

                  {/* JD context */}
                  {(row.jd_responsibilities.length > 0 || row.jd_summary) && (
                    <div>
                      <p className="text-[11px] font-medium text-text-3 uppercase tracking-wide mb-2">JD context</p>
                      <div className="space-y-1">
                        {row.jd_summary && <p className="text-[11px] text-text-2 italic">{row.jd_summary}</p>}
                        {row.jd_responsibilities.slice(0, 4).map((resp, idx) => (
                          <div key={idx} className="flex items-start gap-2 text-[11px] text-text-2">
                            <span className="text-text-3 font-mono shrink-0 mt-0.5">resp[{idx}]</span>
                            <span>{resp}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Similarity */}
                  {sim && sim.score > 0.20 && (
                    <p className="text-[11px] text-text-2">
                      <span className={sim.score > 0.45 ? "text-amber-600 font-medium" : "text-text-3"}>
                        {Math.round(sim.score * 100)}% token overlap
                      </span>{" "}
                      with &ldquo;{sim.peer}&rdquo;
                    </p>
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

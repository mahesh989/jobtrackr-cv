"use client";

import { useEffect, useState } from "react";
import type { RunRow } from "./page";

interface ClassifiedItem {
  item:      string;
  category:  string | null;
  canonical: string | null;
  is_noise:  boolean;
  action:    string;
}

interface AuditedRow extends RunRow {
  classified:  ClassifiedItem[];
  loading:     boolean;
  error?:      string;
}

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

export default function SkillsAuditClient({ rows, totalRuns }: { rows: RunRow[]; totalRuns: number }) {
  const [audited, setAudited] = useState<AuditedRow[]>(
    rows.map((r) => ({ ...r, classified: [], loading: true }))
  );
  const [filter, setFilter] = useState<FilterMode>("gaps_only");
  const [expandedRun, setExpandedRun] = useState<string | null>(null);

  useEffect(() => {
    rows.forEach((row, i) => {
      fetch("/api/internal/classify-skills", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ items: row.other_items, vertical: row.lex_vertical }),
      })
        .then((r) => r.json())
        .then((data: { results?: ClassifiedItem[]; error?: string }) => {
          setAudited((prev) => {
            const next = [...prev];
            next[i] = {
              ...next[i],
              classified: data.results ?? [],
              loading:    false,
              error:      data.error,
            };
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
  // only run once on mount
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Summary stats
  const allGaps = audited.flatMap((r) =>
    r.classified.filter((c) => c.action === "add_to_lexicon").map((c) => c.item.toLowerCase())
  );
  const gapFreq = allGaps.reduce<Record<string, number>>((acc, item) => {
    acc[item] = (acc[item] ?? 0) + 1;
    return acc;
  }, {});
  const topGaps = Object.entries(gapFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20);

  const totalLoading  = audited.filter((r) => r.loading).length;
  const totalComplete = audited.length - totalLoading;

  const displayRows = filter === "gaps_only"
    ? audited.filter((r) => !r.loading && r.classified.some((c) => c.action !== "correct" && c.action !== "correct_technical"))
    : audited;

  return (
    <div className="space-y-6">
      {/* Status bar */}
      <div className="flex items-center gap-4 text-[12px] text-text-2">
        <span>{totalRuns} runs fetched · {audited.length} with Other Skills · {totalComplete}/{audited.length} classified</span>
        {totalLoading > 0 && (
          <span className="text-blue-500 animate-pulse">classifying {totalLoading} remaining…</span>
        )}
        <div className="flex items-center gap-1 ml-auto">
          <button
            onClick={() => setFilter("gaps_only")}
            className={`px-2 py-0.5 rounded border text-[11px] transition-colors ${
              filter === "gaps_only" ? "bg-surface border-border text-text font-medium" : "border-transparent text-text-3 hover:text-text"
            }`}
          >
            Gaps only
          </button>
          <button
            onClick={() => setFilter("all")}
            className={`px-2 py-0.5 rounded border text-[11px] transition-colors ${
              filter === "all" ? "bg-surface border-border text-text font-medium" : "border-transparent text-text-3 hover:text-text"
            }`}
          >
            All runs
          </button>
        </div>
      </div>

      {/* Top gaps summary */}
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

      {/* Run table */}
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

          return (
            <div key={row.run_id} className="border border-border rounded-lg bg-surface overflow-hidden">
              <button
                className="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-surface-hover transition-colors"
                onClick={() => setExpandedRun(isOpen ? null : row.run_id)}
              >
                {/* Job info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-medium text-text truncate">{row.job_title || "(untitled)"}</span>
                    <span className="text-[11px] text-text-3 shrink-0">{row.company}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-2 text-text-3 shrink-0 font-mono">
                      {row.role_family}
                    </span>
                  </div>
                </div>

                {/* Counts */}
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
                    <span className="text-[11px] text-text-3">
                      {correct.length} ✓
                    </span>
                  )}
                  <svg
                    className={`w-3.5 h-3.5 text-text-3 transition-transform ${isOpen ? "rotate-180" : ""}`}
                    fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7"/>
                  </svg>
                </div>
              </button>

              {/* Expanded detail */}
              {isOpen && (
                <div className="border-t border-border px-4 py-3 space-y-3">
                  {row.error && (
                    <p className="text-[11px] text-red-600">Error: {row.error}</p>
                  )}

                  {/* All classified items */}
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

                  {/* All skills labels for context */}
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

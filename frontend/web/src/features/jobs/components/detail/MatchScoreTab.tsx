"use client";

/**
 * Match & score tab — matches v5 prototype exactly.
 * ATS number → CV↔JD intro → breakdown table → matched keywords →
 * missing keywords → credentials & eligibility.
 * No "See full analysis" link (lives in the header), no sub-score tiles.
 */

import type { BoardJob } from "../../lib/jobFilters";
import type { BoardDetailPayload, MatchingData, CategorisedKeywords } from "../../lib/boardDetailTypes";
import { CAT_ORDER } from "../../lib/boardDetailTypes";
import { SKILL_CATEGORY_LABELS, type SkillCategory } from "@/lib/types";

function scoreTone(score: number, thresholds: { initial: number; final: number }): "green" | "amber" | "red" {
  if (score >= thresholds.final) return "green";
  if (score >= thresholds.initial) return "amber";
  return "red";
}

export function MatchScoreTab({ job, detail }: { job: BoardJob; detail: BoardDetailPayload | null }) {
  const run = detail?.run;
  const score = run?.match_score ?? job.initial_ats_score ?? null;
  const thresholds = job.atsThresholds ?? { initial: 60, final: 70 };

  if (score == null) {
    return <p className="text-label text-text-3 italic">No score yet for this job.</p>;
  }

  const tone = scoreTone(score, thresholds);
  const toneClass = tone === "green" ? "text-green-600" : tone === "amber" ? "text-amber-600" : "text-red-600";
  const matching = run?.cv_jd_matching_result;
  const stoppedEarly = tone === "red" && !matching;
  const jd = run?.jd_analysis_result;
  const order = (jd?.category_order as SkillCategory[] | undefined) ?? CAT_ORDER as readonly SkillCategory[] as SkillCategory[];
  const labels = jd?.category_labels as Record<string, string> | undefined ?? SKILL_CATEGORY_LABELS;

  return (
    <div className="space-y-5">
      <div className="pb-[14px] mb-4 border-b border-[var(--border-muted)]">
        <span className={`text-[32px] font-extrabold tabular-nums leading-none tracking-[-0.02em] block ${toneClass}`}>{score}</span>
        <p className="text-[11px] uppercase tracking-[0.04em] text-text-3 font-bold mt-1">Overall match score</p>
      </div>

      {stoppedEarly ? (
        <div className="rounded-[10px] bg-red-light border border-red/20 px-3.5 py-2.5 text-[14px] leading-relaxed text-red">
          <p>This role doesn&apos;t match your profile well — analysis stopped after scoring (no tailored CV or cover letter was generated).</p>
        </div>
      ) : (
        <MatchingContent matching={matching} order={order} labels={labels} />
      )}
    </div>
  );
}

function MatchingContent({ matching, order, labels }: { matching: MatchingData | null | undefined; order: SkillCategory[]; labels: Record<string, string> }) {
  if (!matching) return null;

  const matched  = matching.matched;
  const missed   = matching.missed;
  const counts   = matching.counts;
  const matchRates = matching.match_rates;

  const hasPreferred = order.some((c) => {
    const mp = matched?.preferred?.[c]?.length ?? 0;
    const mip = missed?.preferred?.[c]?.length ?? 0;
    return mp + mip > 0;
  });

  function catRequiredMatched(c: SkillCategory): number {
    return counts?.required?.[c]?.matched ?? matched?.required?.[c]?.length ?? 0;
  }
  function catRequiredTotal(c: SkillCategory): number {
    const fromCounts = counts?.required?.[c]?.total;
    if (fromCounts != null) return fromCounts;
    return (matched?.required?.[c]?.length ?? 0) + (missed?.required?.[c]?.length ?? 0);
  }
  function catPreferredMatched(c: SkillCategory): number {
    return counts?.preferred?.[c]?.matched ?? matched?.preferred?.[c]?.length ?? 0;
  }
  function catPreferredTotal(c: SkillCategory): number {
    const fromCounts = counts?.preferred?.[c]?.total;
    if (fromCounts != null) return fromCounts;
    return (matched?.preferred?.[c]?.length ?? 0) + (missed?.preferred?.[c]?.length ?? 0);
  }

  const totalReqMatched = order.reduce((s, c) => s + catRequiredMatched(c), 0);
  const totalReqAll    = order.reduce((s, c) => s + catRequiredTotal(c), 0);
  const totalPrefMatched = order.reduce((s, c) => s + catPreferredMatched(c), 0);
  const totalPrefAll    = order.reduce((s, c) => s + catPreferredTotal(c), 0);

  const overallRate = matchRates?.required_pct ?? (totalReqAll > 0 ? Math.round((totalReqMatched / totalReqAll) * 100) : 0);
  const prefRate   = matchRates?.preferred_pct ?? (totalPrefAll > 0 ? Math.round((totalPrefMatched / totalPrefAll) * 100) : null);

  return (
    <>
      <p className="text-[14px] text-text-2">
        <b className="text-text font-bold">CV ↔ JD matching</b> — which JD requirements your CV already covers, and which are gaps.
      </p>

      <h4 className="text-[12px] font-bold uppercase tracking-wide text-text mt-5 mb-2">Match breakdown by category</h4>
      <div className="rounded-[10px] border border-border overflow-hidden mb-1">
        <div className="grid grid-cols-[1.9fr_1.2fr_1.2fr_0.9fr] gap-2.5 px-[14px] py-[9px] bg-[#f0f1f4] text-[10.5px] uppercase tracking-[0.03em] font-bold text-text-3">
          <span>Category</span><span>Required</span><span>Preferred</span><span>Match rate</span>
        </div>
        {order.filter((c) => catRequiredTotal(c) > 0 || catPreferredTotal(c) > 0).map((c) => {
          const rMatched = catRequiredMatched(c);
          const rTotal   = catRequiredTotal(c);
          const pMatched = catPreferredMatched(c);
          const pTotal   = catPreferredTotal(c);
          const rate     = rTotal > 0 ? Math.round((rMatched / rTotal) * 100) : 0;
          return (
            <div key={c} className="grid grid-cols-[1.9fr_1.2fr_1.2fr_0.9fr] gap-2.5 px-[14px] py-[9px] text-[13px] border-t border-[var(--border-muted)]">
              <span className="font-semibold text-text">{labels[c] ?? c}</span>
              <span><span className={`${rMatched > 0 ? "text-green-600" : "text-red-600"} font-bold`}>{rMatched}✓</span>{rTotal - rMatched > 0 ? <> <span className="text-red-600 font-bold">{(rTotal - rMatched)}✗</span></> : ""}/{rTotal}</span>
              <span>{pTotal > 0 ? <><span className={`${pMatched > 0 ? "text-green-600" : "text-red-600"} font-bold`}>{pMatched}✓</span>{pTotal - pMatched > 0 ? <> <span className="text-red-600 font-bold">{(pTotal - pMatched)}✗</span></> : ""}/{pTotal}</> : "\u2014"}</span>
              <span className="font-bold text-right text-text">{rate}%</span>
            </div>
          );
        })}
        <div className="grid grid-cols-[1.9fr_1.2fr_1.2fr_0.9fr] gap-2.5 px-[14px] py-[9px] text-[13px] border-t border-[var(--border-muted)] bg-[#fafbfc]">
          <span className="text-text-2">Required total</span>
          <span className="text-text-3 text-[12px]">all categories combined</span>
          <span />
          <span className="font-bold text-right text-text">{overallRate}%</span>
        </div>
        <div className="grid grid-cols-[1.9fr_1.2fr_1.2fr_0.9fr] gap-2.5 px-[14px] py-[9px] text-[13px] border-t border-[var(--border-muted)] bg-[#fafbfc]">
          <span className="text-text-2">Preferred total</span>
          <span className="text-text-3 text-[12px]">{hasPreferred ? "all categories combined" : "no preferred keywords in JD"}</span>
          <span />
          <span className="font-bold text-right text-text">{prefRate != null ? `${prefRate}%` : "\u2014"}</span>
        </div>
      </div>

      <h4 className="text-[12px] font-bold uppercase tracking-wide text-text mt-5 mb-2">Matched keywords</h4>
      <KeywordsSection data={matched?.required} order={order} labels={labels} tone="matched" />

      <h4 className="text-[12px] font-bold uppercase tracking-wide text-text mt-5 mb-2">Missing keywords</h4>
      <KeywordsSection data={missed?.required} order={order} labels={labels} tone="missed" />

      <h4 className="text-[12px] font-bold uppercase tracking-wide text-text mt-5 mb-2">Credentials &amp; eligibility</h4>
      <p className="text-[13px] text-text-3 mb-1">Matched against your CV and saved profile credentials.</p>
      {matching.credentials_required ? (
        <>
          {matching.credentials_required.present?.length ? (
            <div className="mb-2">
              <p className="text-[11px] font-bold text-text-3 uppercase tracking-wider mb-1">Present</p>
              <div className="flex flex-wrap gap-1">
                {matching.credentials_required.present.map((c) => (
                  <span key={c} className="inline-block text-[12.5px] px-[11px] py-[4px] rounded-[20px] mr-1 mb-1 bg-green-light text-green-700">{c}</span>
                ))}
              </div>
            </div>
          ) : null}
          {matching.credentials_required.missing?.length ? (
            <div>
              <p className="text-[11px] font-bold text-text-3 uppercase tracking-wider mb-1">Missing</p>
              <div className="flex flex-wrap gap-1">
                {matching.credentials_required.missing.map((c) => (
                  <span key={c} className="inline-block text-[12.5px] px-[11px] py-[4px] rounded-[20px] mr-1 mb-1 bg-[#f7f8fa] text-text-2 border border-dashed border-[#cbd0d8]">{c}</span>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-[13px] text-text-3">None {'\u2014'} all required credentials present.</p>
          )}
        </>
      ) : (
        <p className="text-[13px] text-text-3 italic">No credential data available.</p>
      )}
    </>
  );
}

function KeywordsSection({ data, order, labels, tone }: { data: CategorisedKeywords | undefined; order: SkillCategory[]; labels: Record<string, string>; tone: "matched" | "missed" }) {
  if (!data) return null;
  const hasAny = order.some((c) => (data[c]?.length ?? 0) > 0);
  if (!hasAny) {
    return <p className="text-[13px] text-text-3 italic">None{'\u2014'}all required skills matched.</p>;
  }
  const variant = tone === "matched" ? "badge-green" : "badge-red";
  return (
    <div className="space-y-1 mt-1">
      {order.filter((c) => (data[c]?.length ?? 0) > 0).map((c) => (
        <div key={c}>
          <p className="text-[11px] font-bold text-text-3 uppercase tracking-wider mb-0.5">{labels[c] ?? c}</p>
          <div className="flex flex-wrap gap-1">
            {(data[c] ?? []).map((kw) => (
              <span key={kw} className={`inline-block text-[12.5px] px-[11px] py-[4px] rounded-[20px] mr-1 mb-1 ${variant === "badge-green" ? "bg-green-light text-green-700" : "bg-red-light text-red-700"}`}>{kw}</span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

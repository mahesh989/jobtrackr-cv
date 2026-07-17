"use client";

/**
 * Faithful port of cv-magic's CVJDMatchingCard:
 *   - Overall keyword-coverage progress bar
 *   - Per-category breakdown table (Required / Preferred / Match rate)
 *   - Matched + Missing keyword chips, grouped by category
 *   - Falls back to a flat string-list view for legacy responses.
 *
 * Restyled with JobTrackr tokens; data shape unchanged from cv-magic.
 */

import type { SkillCategory } from "@/lib/types";
import { SKILL_CATEGORY_ORDER, SKILL_CATEGORY_LABELS } from "@/lib/types";

interface CatCount         { matched: number; total: number }
interface BucketCounts     { technical?: CatCount; soft_skills?: CatCount; domain_knowledge?: CatCount }
interface MatchingCounts   { required?: BucketCounts; preferred?: BucketCounts; overall?: CatCount }
interface CategorisedKeywords { technical?: string[]; soft_skills?: string[]; domain_knowledge?: string[] }
interface BucketKeywords   { required?: CategorisedKeywords; preferred?: CategorisedKeywords }
interface MatchRates {
  technical_pct?:        number; soft_skills_pct?:     number; domain_knowledge_pct?: number;
  required_pct?:         number; preferred_pct?:       number; overall_pct?:          number;
}
interface CredentialsGap {
  required?:    string[];
  preferred?:   string[];
  eligibility?: string[];
  present?:     string[];
  missing?:     string[];
}
interface MatchingData {
  matched?:        BucketKeywords;
  missed?:         BucketKeywords;
  counts?:         MatchingCounts;
  match_rates?:    MatchRates;
  credentials_required?: CredentialsGap;
  // Legacy flat fields
  matched_skills?: string[];
  missing_skills?: string[];
  match_summary?:  string;
}

const CAT_ORDER = SKILL_CATEGORY_ORDER;
type Cat = SkillCategory;
const CAT_LABEL: Record<Cat, string> = SKILL_CATEGORY_LABELS;

function rateBadgeCls(pct: number) {
  if (pct >= 70) return "bg-green-light text-green border-green/30";
  if (pct >= 40) return "bg-[#FFF8C5] text-[#9A6700] border-[#D4A72C]/40";
  return "bg-red-light text-red border-red/30";
}

export function CvJdMatchingCard({
  data, catLabels = CAT_LABEL, catOrder = [...CAT_ORDER],
}: {
  data: Record<string, unknown>;
  catLabels?: Record<string, string>;
  catOrder?: Cat[];
}) {
  const d = data as MatchingData;
  const hasCategorised = !!d.counts;

  return (
    <div className="bg-surface border border-border rounded-md overflow-hidden">
      <div className="px-5 py-3 border-b border-border bg-surface-2">
        <h2 className="text-[14px] font-semibold text-text">CV ↔ JD matching</h2>
        <p className="text-[12px] text-text-3 mt-0.5">
          Which JD requirements your CV already covers, and which are gaps.
        </p>
      </div>
      <div className="px-5 py-4 space-y-5">
        {hasCategorised ? <CategorisedView d={d} catLabels={catLabels} catOrder={catOrder} /> : <LegacyFlatView d={d} />}
      </div>
    </div>
  );
}

// ── Categorised view (new schema) ──────────────────────────────────────────

function CategorisedView({ d, catLabels, catOrder }: { d: MatchingData; catLabels: Record<string, string>; catOrder: Cat[] }) {
  const counts  = d.counts!;
  const rates   = d.match_rates ?? {};
  const overall = counts.overall;

  return (
    <>
      {overall && overall.total > 0 && (
        <div className="flex items-center gap-3 rounded border border-border bg-surface-2/50 p-3">
          <div className="text-[22px] font-bold tabular-nums text-text">
            {overall.matched}
            <span className="text-[14px] font-normal text-text-3">/{overall.total}</span>
          </div>
          <div className="flex-1">
            <div className="flex justify-between text-[11px] mb-1">
              <span className="font-medium text-text">Overall keyword coverage</span>
              <span className="text-text-3 tabular-nums">
                {(rates.overall_pct ?? Math.round((overall.matched / overall.total) * 100))}%
              </span>
            </div>
            <div className="h-2 rounded-full bg-surface border border-border overflow-hidden">
              <div
                className="h-full rounded-full bg-[var(--brand)] transition-all"
                style={{ width: `${rates.overall_pct ?? Math.round((overall.matched / overall.total) * 100)}%` }}
              />
            </div>
          </div>
        </div>
      )}

      <BreakdownTable counts={counts} rates={rates} catLabels={catLabels} catOrder={catOrder} />

      <KeywordChipGrid matched={d.matched} missed={d.missed} catLabels={catLabels} catOrder={catOrder} />

      <CredentialGapBlock creds={d.credentials_required} />
    </>
  );
}

// ── Credential gap (present / missing against CV + profile) ─────────────────

function CredentialGapBlock({ creds }: { creds?: CredentialsGap }) {
  if (!creds) return null;
  const present = Array.from(new Set(creds.present ?? []));
  const missing = Array.from(new Set(creds.missing ?? []));
  if (present.length === 0 && missing.length === 0) return null;

  const chip = (kw: string, color: "green" | "red") => (
    <span
      key={kw}
      className={`text-[11px] px-1.5 py-0.5 rounded border font-mono ${
        color === "green"
          ? "bg-green-light text-green border-green/30"
          : "bg-red-light text-red border-red/30"
      }`}
    >
      {kw}
    </span>
  );

  return (
    <div>
      <h3 className="text-[10px] font-semibold uppercase tracking-widest text-text-3 mb-2">
        Credentials &amp; eligibility
      </h3>
      <p className="text-[11px] text-text-3 mb-2">
        Matched against your CV and saved profile credentials.
      </p>
      <div className="space-y-2">
        {present.length > 0 && (
          <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
            <span className="mt-0.5 shrink-0 text-[10px] font-semibold uppercase tracking-widest text-green bg-green-light border border-green/30 rounded px-1.5 py-0.5">
              Present
            </span>
            <div className="flex flex-wrap gap-1">{present.map((kw) => chip(kw, "green"))}</div>
          </div>
        )}
        {missing.length > 0 && (
          <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
            <span className="mt-0.5 shrink-0 text-[10px] font-semibold uppercase tracking-widest text-red bg-red-light border border-red/30 rounded px-1.5 py-0.5">
              Missing
            </span>
            <div className="flex flex-wrap gap-1">{missing.map((kw) => chip(kw, "red"))}</div>
          </div>
        )}
      </div>
    </div>
  );
}

function BreakdownTable({
  counts, rates, catLabels, catOrder,
}: {
  counts: MatchingCounts;
  rates: MatchRates;
  catLabels: Record<string, string>;
  catOrder: Cat[];
}) {
  const catRatePct: Record<Cat, number | undefined> = {
    technical:        rates.technical_pct,
    soft_skills:      rates.soft_skills_pct,
    domain_knowledge: rates.domain_knowledge_pct,
  };

  const sumTotals = (b?: BucketCounts) =>
    catOrder.reduce((acc, c) => acc + (b?.[c]?.total ?? 0), 0);
  const requiredTotal  = sumTotals(counts.required);
  const preferredTotal = sumTotals(counts.preferred);

  return (
    <div>
      <h3 className="text-[10px] font-semibold uppercase tracking-widest text-text-3 mb-2">
        Match breakdown by category
      </h3>
      <div className="overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="border-b border-border text-left text-[11px] text-text-3">
              <th className="pb-2 pr-3 font-medium">Category</th>
              <th className="pb-2 pr-3 text-center font-medium">Required</th>
              <th className="pb-2 pr-3 text-center font-medium">Preferred</th>
              <th className="pb-2 text-right font-medium">Match rate</th>
            </tr>
          </thead>
          <tbody>
            {catOrder.map((cat) => {
              const req  = counts.required?.[cat];
              const pref = counts.preferred?.[cat];
              const catPct = catRatePct[cat];
              const totalKw = (req?.total ?? 0) + (pref?.total ?? 0);
              if (totalKw === 0) return null;
              const reqHas  = req  && req.total  > 0;
              const prefHas = pref && pref.total > 0;
              return (
                <tr key={cat} className="border-b border-border/60">
                  <td className="py-2 pr-3 font-medium text-text">{catLabels[cat]}</td>
                  <td className="py-2 pr-3 text-center">
                    {reqHas ? <MatchCell matched={req!.matched} total={req!.total} /> : <span className="text-text-3">—</span>}
                  </td>
                  <td className="py-2 pr-3 text-center">
                    {prefHas ? <MatchCell matched={pref!.matched} total={pref!.total} /> : <span className="text-text-3">—</span>}
                  </td>
                  <td className="py-2 text-right">
                    {catPct != null ? (
                      <span className={`inline-block rounded px-2 py-0.5 text-[11px] font-semibold tabular-nums border ${rateBadgeCls(catPct)}`}>
                        {catPct}%
                      </span>
                    ) : <span className="text-text-3">—</span>}
                  </td>
                </tr>
              );
            })}
            {(rates.required_pct != null || rates.preferred_pct != null) && (
              <>
                <tr className="bg-surface-2/40 font-medium">
                  <td className="py-2 pr-3 text-[11px] text-text-3">Required total</td>
                  <td colSpan={2} className="py-2 pr-3 text-center text-[11px] text-text-3">
                    {requiredTotal > 0 ? "all categories combined" : "no required keywords in JD"}
                  </td>
                  <td className="py-2 text-right">
                    {requiredTotal > 0 && rates.required_pct != null ? (
                      <span className={`inline-block rounded px-2 py-0.5 text-[11px] font-semibold tabular-nums border ${rateBadgeCls(rates.required_pct)}`}>
                        {rates.required_pct}%
                      </span>
                    ) : <span className="text-text-3">—</span>}
                  </td>
                </tr>
                <tr className="bg-surface-2/40 font-medium">
                  <td className="py-2 pr-3 text-[11px] text-text-3">Preferred total</td>
                  <td colSpan={2} className="py-2 pr-3 text-center text-[11px] text-text-3">
                    {preferredTotal > 0 ? "all categories combined" : "no preferred keywords in JD"}
                  </td>
                  <td className="py-2 text-right">
                    {preferredTotal > 0 && rates.preferred_pct != null ? (
                      <span className={`inline-block rounded px-2 py-0.5 text-[11px] font-semibold tabular-nums border ${rateBadgeCls(rates.preferred_pct)}`}>
                        {rates.preferred_pct}%
                      </span>
                    ) : <span className="text-text-3">—</span>}
                  </td>
                </tr>
              </>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MatchCell({ matched, total }: { matched: number; total: number }) {
  const missed = total - matched;
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] tabular-nums">
      <span className="font-semibold text-green">{matched}✓</span>
      {missed > 0 && <span className="text-red">{missed}✗</span>}
      <span className="text-text-3">/{total}</span>
    </span>
  );
}

// ── Keyword chips grouped by category ──────────────────────────────────────

function KeywordChipGrid({
  matched, missed, catLabels, catOrder,
}: {
  matched?: BucketKeywords;
  missed?: BucketKeywords;
  catLabels: Record<string, string>;
  catOrder: Cat[];
}) {
  const merge = (bk?: BucketKeywords): Record<Cat, string[]> => {
    const out: Record<Cat, string[]> = { technical: [], soft_skills: [], domain_knowledge: [] };
    if (!bk) return out;
    for (const bucket of ["required", "preferred"] as const) {
      const b = bk[bucket];
      if (!b) continue;
      for (const c of catOrder) {
        if (b[c]) out[c].push(...b[c]!);
      }
    }
    // De-duplicate within each cat
    for (const c of catOrder) out[c] = Array.from(new Set(out[c]));
    return out;
  };

  const m = merge(matched);
  const x = merge(missed);
  const anyM = catOrder.some((c) => m[c].length > 0);
  const anyX = catOrder.some((c) => x[c].length > 0);
  if (!anyM && !anyX) return null;

  return (
    <div className="space-y-4">
      {anyM && (
        <ChipBlock
          title="Matched keywords"
          color="green"
          buckets={m}
          catLabels={catLabels}
          catOrder={catOrder}
        />
      )}
      {anyX && (
        <ChipBlock
          title="Missing keywords"
          color="red"
          buckets={x}
          catLabels={catLabels}
          catOrder={catOrder}
        />
      )}
    </div>
  );
}

function ChipBlock({
  title, color, buckets, catLabels, catOrder,
}: {
  title: string;
  color: "green" | "red";
  buckets: Record<Cat, string[]>;
  catLabels: Record<string, string>;
  catOrder: Cat[];
}) {
  const titleCls = color === "green" ? "text-green" : "text-red";
  const chipCls  = color === "green"
    ? "bg-green-light text-green border-green/30"
    : "bg-red-light text-red border-red/30";
  return (
    <div>
      <h3 className={`text-[10px] font-semibold uppercase tracking-widest mb-2 ${titleCls}`}>{title}</h3>
      <div className="space-y-2">
        {catOrder.map((cat) => {
          const kws = buckets[cat];
          if (!kws.length) return null;
          return (
            <div key={cat} className="flex flex-wrap items-start gap-x-2 gap-y-1">
              <span className="mt-0.5 shrink-0 text-[10px] font-semibold uppercase tracking-widest text-text-3 bg-surface-2 border border-border rounded px-1.5 py-0.5">
                {catLabels[cat]}
              </span>
              <div className="flex flex-wrap gap-1">
                {kws.map((kw) => (
                  <span key={kw} className={`text-[11px] px-1.5 py-0.5 rounded border font-mono ${chipCls}`}>
                    {kw}
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Legacy flat view (fallback) ────────────────────────────────────────────

function LegacyFlatView({ d }: { d: MatchingData }) {
  return (
    <div className="space-y-4">
      {d.match_summary && (
        <p className="text-[13px] text-text-2 italic leading-relaxed">{d.match_summary}</p>
      )}
      {d.matched_skills && d.matched_skills.length > 0 && (
        <FlatList label="Matched" items={d.matched_skills} color="green" />
      )}
      {d.missing_skills && d.missing_skills.length > 0 && (
        <FlatList label="Missing" items={d.missing_skills} color="red" />
      )}
    </div>
  );
}

function FlatList({ label, items, color }: { label: string; items: string[]; color: "green" | "red" }) {
  const chipCls = color === "green"
    ? "bg-green-light text-green border-green/30"
    : "bg-red-light text-red border-red/30";
  return (
    <div>
      <h3 className="text-[10px] font-semibold uppercase tracking-widest text-text-3 mb-1.5">{label}</h3>
      <div className="flex flex-wrap gap-1">
        {items.map((s) => (
          <span key={s} className={`text-[11px] px-1.5 py-0.5 rounded border font-mono ${chipCls}`}>
            {s}
          </span>
        ))}
      </div>
    </div>
  );
}

"use client";

/**
 * Faithful port of cv-magic's ATSScoreCard:
 *   - Big overall_score (0-100) with subtitle
 *   - Three named sub-score tiles: Keyword match, Experience match, Formatting
 *   - Falls back to a 'breakdown' object/array for legacy responses.
 */

interface AtsBreakdownItem {
  category?:    string;
  score?:       number;
  weight?:      number;
  description?: string;
}

interface AtsScoringData {
  overall_score?:           number;
  keyword_match_score?:     number;
  experience_match_score?:  number;
  formatting_score?:        number;
  breakdown?:               AtsBreakdownItem[] | Record<string, unknown>;
  strengths?:               string[];
  weaknesses?:              string[];
}

function scoreColor(s: number) {
  if (s >= 80) return "text-green bg-green-light border-green/30";
  if (s >= 60) return "text-[#9A6700] bg-[#FFF8C5] border-[#D4A72C]/40";
  return "text-red bg-red-light border-red/30";
}

export function AtsScoreCard({ data }: { data: Record<string, unknown> }) {
  const d = data as AtsScoringData;
  const overall = typeof d.overall_score === "number" ? d.overall_score : null;

  return (
    <div className="bg-surface border border-border rounded-md overflow-hidden">
      <div className="px-5 py-3 border-b border-border bg-surface-2">
        <h2 className="text-title font-semibold text-text">ATS score</h2>
      </div>
      <div className="px-5 py-4 space-y-4">
        {overall !== null && (
          <div>
            <div className="flex items-baseline gap-3">
              <span className={`text-[28px] font-bold tabular-nums px-3 py-1 rounded border ${scoreColor(overall)}`}>
                {Math.round(overall)}
              </span>
              <div>
                <p className="text-body font-medium text-text">Overall match score</p>
                <p className="text-caption text-text-3 leading-snug">
                  Weighted from keyword, experience, and formatting sub-scores.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Named sub-scores — cv-magic's three-up layout */}
        {(typeof d.keyword_match_score === "number"
          || typeof d.experience_match_score === "number"
          || typeof d.formatting_score === "number") && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <SubScore label="Keyword match"    value={d.keyword_match_score} />
            <SubScore label="Experience match" value={d.experience_match_score} />
            <SubScore label="Formatting"       value={d.formatting_score} />
          </div>
        )}

        {(d.strengths && d.strengths.length > 0) && (
          <ListBlock label="Strengths"  items={d.strengths}  cls="text-green" />
        )}
        {(d.weaknesses && d.weaknesses.length > 0) && (
          <ListBlock label="Weaknesses" items={d.weaknesses} cls="text-red" />
        )}
      </div>
    </div>
  );
}

function SubScore({ label, value }: { label: string; value: number | undefined }) {
  const has = typeof value === "number";
  const v = has ? Math.round(value!) : null;
  return (
    <div className="bg-surface-2 border border-border rounded p-3">
      <div className="text-micro uppercase tracking-wide text-text-3">{label}</div>
      <div className="mt-1.5 flex items-baseline gap-2">
        <span className={`text-h2 font-bold tabular-nums ${has ? scoreColor(v!).split(" ")[0] : "text-text-3"}`}>
          {v ?? "—"}
        </span>
        {has && <span className="text-caption text-text-3">/ 100</span>}
      </div>
      {has && (
        <div className="mt-2 h-1.5 rounded-full bg-surface border border-border overflow-hidden">
          <div
            className={`h-full rounded-full ${
              v! >= 80 ? "bg-green"
              : v! >= 60 ? "bg-[#D4A72C]"
              : "bg-red"
            }`}
            style={{ width: `${Math.max(0, Math.min(100, v!))}%` }}
          />
        </div>
      )}
    </div>
  );
}

function ListBlock({ label, items, cls }: { label: string; items: string[]; cls: string }) {
  return (
    <div>
      <h3 className={`text-micro font-semibold uppercase tracking-widest mb-1.5 ${cls}`}>{label}</h3>
      <ul className="space-y-1">
        {items.map((s, i) => (
          <li key={i} className="flex gap-2 text-label text-text-2">
            <span className="text-text-3 mt-0.5">•</span>
            <span>{s}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

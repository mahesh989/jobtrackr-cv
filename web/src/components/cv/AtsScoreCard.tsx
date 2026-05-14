"use client";

interface AtsBreakdownItem {
  category?:   string;
  score?:      number;     // 0-100
  weight?:     number;
  description?: string;
}

interface AtsScoringData {
  overall_score?: number;          // 0-100
  breakdown?:     AtsBreakdownItem[] | Record<string, number>;
  strengths?:     string[];
  weaknesses?:    string[];
}

const scoreColor = (s: number) => {
  if (s >= 80) return "text-green bg-green-light border-green/30";
  if (s >= 60) return "text-[#9A6700] bg-[#FFF8C5] border-[#D4A72C]/40";
  return "text-red bg-red-light border-red/30";
};

export function AtsScoreCard({ data }: { data: Record<string, unknown> }) {
  const d = data as AtsScoringData;
  const overall = typeof d.overall_score === "number" ? d.overall_score : null;

  const breakdownEntries: { label: string; score: number }[] = [];
  if (Array.isArray(d.breakdown)) {
    for (const b of d.breakdown) {
      if (b.category && typeof b.score === "number") {
        breakdownEntries.push({ label: b.category, score: b.score });
      }
    }
  } else if (d.breakdown && typeof d.breakdown === "object") {
    for (const [k, v] of Object.entries(d.breakdown)) {
      if (typeof v === "number") breakdownEntries.push({ label: k, score: v });
    }
  }

  return (
    <div className="bg-surface border border-border rounded-md overflow-hidden">
      <div className="px-5 py-3 border-b border-border bg-surface-2">
        <h2 className="text-[14px] font-semibold text-text">ATS scoring</h2>
        <p className="text-[12px] text-text-3 mt-0.5">
          How well your current CV matches this job, before tailoring.
        </p>
      </div>
      <div className="px-5 py-4 space-y-4">
        {overall !== null && (
          <div className="flex items-baseline gap-3">
            <span className={`text-[28px] font-bold tabular-nums px-3 py-1 rounded border ${scoreColor(overall)}`}>
              {Math.round(overall)}
            </span>
            <span className="text-[12px] text-text-3">/ 100 overall</span>
          </div>
        )}
        {breakdownEntries.length > 0 && (
          <div className="space-y-2">
            {breakdownEntries.map((b) => (
              <div key={b.label} className="flex items-center gap-3 text-[12px]">
                <span className="w-40 text-text-2 shrink-0 capitalize">{b.label.replace(/_/g, " ")}</span>
                <div className="flex-1 h-2 bg-surface-2 border border-border rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full ${b.score >= 80 ? "bg-green" : b.score >= 60 ? "bg-[#D4A72C]" : "bg-red"}`}
                    style={{ width: `${Math.max(0, Math.min(100, b.score))}%` }}
                  />
                </div>
                <span className="w-10 text-right text-text-2 tabular-nums">{Math.round(b.score)}</span>
              </div>
            ))}
          </div>
        )}
        {(d.strengths && d.strengths.length > 0) && (
          <ListBlock label="Strengths" items={d.strengths} color="text-green" />
        )}
        {(d.weaknesses && d.weaknesses.length > 0) && (
          <ListBlock label="Weaknesses" items={d.weaknesses} color="text-red" />
        )}
      </div>
    </div>
  );
}

function ListBlock({ label, items, color }: { label: string; items: string[]; color: string }) {
  return (
    <div>
      <h3 className={`text-[10px] font-semibold uppercase tracking-widest mb-1.5 ${color}`}>{label}</h3>
      <ul className="space-y-1">
        {items.map((s, i) => (
          <li key={i} className="flex gap-2 text-[12px] text-text-2">
            <span className="text-text-3 mt-0.5">•</span>
            <span>{s}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

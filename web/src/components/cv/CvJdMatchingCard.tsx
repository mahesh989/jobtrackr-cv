"use client";

interface MatchedSkillEntry {
  keyword?: string;
  evidence?: string;
}

interface MissingSkillEntry {
  keyword?: string;
  category?: "technical" | "soft_skills" | "domain_knowledge";
  importance?: "required" | "preferred";
}

interface CvJdMatchingData {
  match_summary?:     string;
  overall_alignment?: number;
  matched_skills?:    MatchedSkillEntry[] | string[];
  missing_skills?:    MissingSkillEntry[] | string[];
  matched_keywords?:  string[];
  missing_keywords?:  string[];
}

// Renders both nested-object and flat-string variants safely.
function asString(s: unknown): string {
  if (typeof s === "string") return s;
  if (s && typeof s === "object") {
    const o = s as { keyword?: string; skill?: string; name?: string };
    return o.keyword ?? o.skill ?? o.name ?? "";
  }
  return "";
}

export function CvJdMatchingCard({ data }: { data: Record<string, unknown> }) {
  const d = data as CvJdMatchingData;
  const matched = (d.matched_skills ?? d.matched_keywords ?? []) as Array<string | MatchedSkillEntry>;
  const missing = (d.missing_skills ?? d.missing_keywords ?? []) as Array<string | MissingSkillEntry>;

  return (
    <div className="bg-surface border border-border rounded-md overflow-hidden">
      <div className="px-5 py-3 border-b border-border bg-surface-2">
        <h2 className="text-[14px] font-semibold text-text">CV ↔ JD matching</h2>
        <p className="text-[12px] text-text-3 mt-0.5">
          Which JD requirements your CV already covers, and which are gaps.
        </p>
      </div>
      <div className="px-5 py-4 space-y-4">
        {d.match_summary && (
          <p className="text-[13px] text-text-2 italic leading-relaxed">{d.match_summary}</p>
        )}
        {typeof d.overall_alignment === "number" && (
          <div className="flex items-baseline gap-2 text-[12px] text-text-3">
            <span>Overall alignment:</span>
            <span className="text-[14px] font-semibold text-text tabular-nums">
              {Math.round(d.overall_alignment)}%
            </span>
          </div>
        )}

        {matched.length > 0 && (
          <div>
            <h3 className="text-[10px] font-semibold uppercase tracking-widest text-green mb-2">
              Matched ({matched.length})
            </h3>
            <div className="flex flex-wrap gap-1">
              {matched.map((m, i) => (
                <span key={i} className="text-[11px] px-1.5 py-0.5 rounded border bg-green-light text-green border-green/20">
                  {asString(m)}
                </span>
              ))}
            </div>
          </div>
        )}

        {missing.length > 0 && (
          <div>
            <h3 className="text-[10px] font-semibold uppercase tracking-widest text-red mb-2">
              Missing ({missing.length})
            </h3>
            <div className="flex flex-wrap gap-1">
              {missing.map((m, i) => {
                const label = asString(m);
                const importance = typeof m === "object" ? (m as MissingSkillEntry).importance : undefined;
                const cls = importance === "required"
                  ? "bg-red-light text-red border-red/30"
                  : "bg-surface-2 text-text-2 border-border";
                return (
                  <span key={i} className={`text-[11px] px-1.5 py-0.5 rounded border ${cls}`}>
                    {label}{importance === "required" ? " *" : ""}
                  </span>
                );
              })}
            </div>
            {missing.some((m) => typeof m === "object" && (m as MissingSkillEntry).importance === "required") && (
              <p className="text-[10px] text-text-3 mt-1.5">* required by the JD</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

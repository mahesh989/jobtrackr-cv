"use client";

interface FeasibilityEntry {
  keyword?:     string;
  category?:    "technical" | "soft_skills" | "domain_knowledge";
  justification?: string;
  target_section?: string;
  injection_text?: string;
}

interface FeasibilityPlan {
  inject_directly?:      FeasibilityEntry[];
  inject_as_extension?:  FeasibilityEntry[];
  honest_gaps?:          FeasibilityEntry[];
}

interface FeasibilityData {
  feasibility_plan?: FeasibilityPlan;
  summary?:          string;
}

export function FeasibilityCard({ data }: { data: Record<string, unknown> }) {
  const d = data as FeasibilityData;
  const plan = d.feasibility_plan ?? {};
  const inject = plan.inject_directly ?? [];
  const ext    = plan.inject_as_extension ?? [];
  const gaps   = plan.honest_gaps ?? [];

  const total = inject.length + ext.length + gaps.length;
  if (total === 0 && !d.summary) return null;

  return (
    <div className="bg-surface border border-border rounded-md overflow-hidden">
      <div className="px-5 py-3 border-b border-border bg-surface-2">
        <h2 className="text-[14px] font-semibold text-text">Keyword feasibility</h2>
        <p className="text-[12px] text-text-3 mt-0.5">
          Which missing JD keywords can be legitimately surfaced in your tailored
          CV, and which are honest gaps.
        </p>
      </div>
      <div className="px-5 py-4 space-y-4">
        {d.summary && (
          <p className="text-[13px] text-text-2 italic leading-relaxed">{d.summary}</p>
        )}

        {inject.length > 0 && (
          <FeasibilityList
            label={`Inject directly (${inject.length})`}
            sublabel="Already supported by your CV — just needs to appear in the right spot."
            items={inject}
            badgeCls="bg-green-light text-green border-green/30"
          />
        )}

        {ext.length > 0 && (
          <FeasibilityList
            label={`Inject as extension (${ext.length})`}
            sublabel="Plausibly extendable from what your CV says — reframe carefully."
            items={ext}
            badgeCls="bg-[#FFF8C5] text-[#9A6700] border-[#D4A72C]/40"
          />
        )}

        {gaps.length > 0 && (
          <FeasibilityList
            label={`Honest gaps (${gaps.length})`}
            sublabel="Cannot be honestly claimed. Won't be added to the tailored CV."
            items={gaps}
            badgeCls="bg-red-light text-red border-red/30"
          />
        )}
      </div>
    </div>
  );
}

function FeasibilityList({
  label, sublabel, items, badgeCls,
}: {
  label:    string;
  sublabel: string;
  items:    FeasibilityEntry[];
  badgeCls: string;
}) {
  return (
    <div>
      <h3 className="text-[11px] font-semibold text-text mb-0.5">{label}</h3>
      <p className="text-[11px] text-text-3 mb-2">{sublabel}</p>
      <ul className="space-y-1.5">
        {items.map((it, i) => (
          <li key={i} className="text-[12px]">
            <div className="flex items-baseline gap-2">
              <span className={`shrink-0 px-1.5 py-0.5 rounded border text-[10px] font-medium ${badgeCls}`}>
                {it.keyword ?? "—"}
              </span>
              {it.category && (
                <span className="text-[10px] text-text-3 uppercase tracking-wide">{it.category.replace("_", " ")}</span>
              )}
            </div>
            {it.justification && (
              <p className="text-text-3 ml-1 mt-0.5 leading-snug">{it.justification}</p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

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

interface FeasibilitySummary {
  n_inject_directly?:        number;
  n_inject_as_extension?:    number;
  n_inject_with_inference?:  number;
  n_cannot_inject?:          number;
  honest_gaps?:              number;
  expected_lift_pts?:        number;
}

interface FeasibilityData {
  feasibility_plan?: FeasibilityPlan;
  summary?:          FeasibilitySummary | string;
}

export function FeasibilityCard({ data }: { data: Record<string, unknown> }) {
  const d = data as FeasibilityData;
  const plan = d.feasibility_plan ?? {};
  const inject = plan.inject_directly ?? [];
  const ext    = plan.inject_as_extension ?? [];
  const gaps   = plan.honest_gaps ?? [];

  // summary is an object on the current cv-magic schema, but tolerate string
  // (older/alternate prompts) for forward-compat.
  const summaryObj = (d.summary && typeof d.summary === "object") ? d.summary as FeasibilitySummary : null;
  const summaryStr = typeof d.summary === "string" ? d.summary : null;

  const total = inject.length + ext.length + gaps.length;
  if (total === 0 && !summaryObj && !summaryStr) return null;

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
        {summaryObj && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
            <SummaryStat label="Direct adds"    value={summaryObj.n_inject_directly}       tone="green" />
            <SummaryStat label="Reword bullets" value={summaryObj.n_inject_as_extension}   tone="blue" />
            <SummaryStat label="From inference" value={summaryObj.n_inject_with_inference} tone="violet" />
            <SummaryStat label="Honest gaps"    value={summaryObj.n_cannot_inject ?? summaryObj.honest_gaps} tone="amber" />
            <SummaryStat
              label="Predicted lift"
              value={typeof summaryObj.expected_lift_pts === "number"
                ? `+${summaryObj.expected_lift_pts.toFixed(1)} pts`
                : "—"}
              tone="gray"
            />
          </div>
        )}
        {summaryStr && (
          <p className="text-[13px] text-text-2 italic leading-relaxed">{summaryStr}</p>
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

function SummaryStat({
  label, value, tone,
}: {
  label: string;
  value: number | string | undefined;
  tone:  "green" | "blue" | "violet" | "amber" | "gray";
}) {
  const toneCls = {
    green:  "text-green bg-green-light border-green/30",
    blue:   "text-[#0969DA] bg-[#DDF4FF] border-[#0969DA]/20",
    violet: "text-[#8250DF] bg-[#FBEFFF] border-[#8250DF]/20",
    amber:  "text-[#9A6700] bg-[#FFF8C5] border-[#D4A72C]/40",
    gray:   "text-text-2 bg-surface-2 border-border",
  }[tone];
  return (
    <div className="bg-surface-2 border border-border rounded p-2">
      <div className="text-[10px] uppercase tracking-wide text-text-3">{label}</div>
      <div className={`mt-1 inline-block text-[14px] font-bold tabular-nums px-2 py-0.5 rounded border ${toneCls}`}>
        {value ?? "—"}
      </div>
    </div>
  );
}

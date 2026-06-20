"use client";

/**
 * Renders the structured JD analysis (step 1 output) as a readable card.
 * Ported from cv-magic and restyled with JobTrackr design tokens.
 */

import { AlertTriangle } from "lucide-react";

interface CategorisedSkills {
  technical?:         string[];
  soft_skills?:       string[];
  domain_knowledge?:  string[];
}

interface Credentials {
  required?:    string[];
  preferred?:   string[];
  eligibility?: string[];
}

interface JobContext {
  setting?:  string | null;
  settings?: string[];
}

interface JDAnalysisData {
  job_title?:                 string;
  seniority_level?:           string;
  summary?:                   string;
  required_skills?:           CategorisedSkills | string[];
  preferred_skills?:          CategorisedSkills | string[];
  responsibilities?:          string[];
  experience_years_required?: number | null;
  category_labels?:           Record<string, string>;
  category_order?:            string[];
  credentials?:               Credentials;
  job_context?:               JobContext;
}

const CAT_LABEL: Record<string, string> = {
  technical:         "Technical",
  soft_skills:       "Soft skills",
  domain_knowledge:  "Domain knowledge",
};
type Cat = "technical" | "soft_skills" | "domain_knowledge";
const DEFAULT_CAT_ORDER: Cat[] = ["technical", "soft_skills", "domain_knowledge"];

function resolveCatLabels(data: Record<string, unknown>): Record<string, string> {
  const raw = (data as { category_labels?: Record<string, string> }).category_labels;
  if (!raw || typeof raw !== "object") return CAT_LABEL;
  return { ...CAT_LABEL, ...raw };
}

function resolveCatOrder(data: Record<string, unknown>): Cat[] {
  const raw = (data as { category_order?: string[] }).category_order;
  if (!Array.isArray(raw)) return DEFAULT_CAT_ORDER;
  const valid = raw.filter(
    (k): k is Cat => k === "technical" || k === "soft_skills" || k === "domain_knowledge",
  );
  return valid.length === 3 ? valid : DEFAULT_CAT_ORDER;
}

function hasAnySkills(s: CategorisedSkills | string[] | undefined | null): boolean {
  if (!s) return false;
  if (Array.isArray(s)) return s.length > 0;
  return Object.values(s).some((arr) => Array.isArray(arr) && arr.length > 0);
}

function isWeakAnalysis(d: JDAnalysisData): boolean {
  const noResp    = !d.responsibilities  || d.responsibilities.length === 0;
  const noReq     = !hasAnySkills(d.required_skills);
  const noPref    = !hasAnySkills(d.preferred_skills);
  const noTitle   = !d.job_title;
  const unknownSr = !d.seniority_level || d.seniority_level === "unknown";
  return noResp && noReq && noPref && (noTitle || unknownSr);
}

function hasAnyCredentials(c: Credentials | undefined | null): boolean {
  if (!c) return false;
  return (
    (c.required?.length ?? 0) > 0 ||
    (c.preferred?.length ?? 0) > 0 ||
    (c.eligibility?.length ?? 0) > 0
  );
}

export function JdAnalysisCard({ data }: { data: Record<string, unknown> }) {
  const d         = data as JDAnalysisData;
  const req       = d.required_skills;
  const pref      = d.preferred_skills;
  const creds     = d.credentials;
  const ctx       = d.job_context;
  const reqIsCategorised  = req  != null && !Array.isArray(req)  && typeof req  === "object";
  const prefIsCategorised = pref != null && !Array.isArray(pref) && typeof pref === "object";
  const weak      = isWeakAnalysis(d);
  const catLabels = resolveCatLabels(data);
  const catOrder  = resolveCatOrder(data);

  return (
    <div className="bg-surface border border-border rounded-md overflow-hidden">
      <div className="px-5 py-3 border-b border-border bg-surface-2 flex items-center gap-2">
        <svg className="w-4 h-4 text-text-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
          <path strokeLinecap="round" strokeLinejoin="round" d="M20 7h-4V3.5a1.5 1.5 0 00-1.5-1.5h-5A1.5 1.5 0 008 3.5V7H4a2 2 0 00-2 2v9a2 2 0 002 2h16a2 2 0 002-2V9a2 2 0 00-2-2zm-10-3h4v3h-4V4z"/>
        </svg>
        <h2 className="text-[14px] font-semibold text-text">Job description analysis</h2>
      </div>

      <div className="px-5 py-4 space-y-4">
        {/* Title + seniority + experience + setting badge */}
        {(d.job_title || d.seniority_level || d.experience_years_required != null || ctx?.setting) && (
          <div className="flex flex-wrap items-center gap-2">
            {d.job_title && (
              <span className="text-[14px] font-semibold text-text">{d.job_title}</span>
            )}
            {d.seniority_level && d.seniority_level !== "unknown" && (
              <span className="text-[11px] uppercase tracking-wide bg-[#DDF4FF] text-[var(--brand)] border border-[var(--brand)]/20 px-1.5 py-0.5 rounded">
                {d.seniority_level}
              </span>
            )}
            {typeof d.experience_years_required === "number" && d.experience_years_required > 0 && (
              <span className="text-[11px] text-text-3 bg-surface-2 border border-border px-1.5 py-0.5 rounded">
                {d.experience_years_required}+ yrs
              </span>
            )}
            {ctx?.setting && (
              <span className="text-[11px] text-text-2 bg-surface-2 border border-border px-1.5 py-0.5 rounded capitalize">
                {ctx.setting}
              </span>
            )}
          </div>
        )}

        {d.summary && (
          weak ? (
            <div className="flex items-start gap-2 p-3 rounded-md border-2 border-red-200 bg-red-50">
              <AlertTriangle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
              <p className="text-[13px] font-bold text-red-700 leading-relaxed">{d.summary}</p>
            </div>
          ) : (
            <p className="text-[13px] text-text-2 leading-relaxed italic">{d.summary}</p>
          )
        )}

        {/* Required skills */}
        {req && (
          <SkillBlock label="Required skills" skills={req} categorised={reqIsCategorised} variant="required" catLabels={catLabels} catOrder={catOrder} />
        )}

        {/* Preferred skills */}
        {pref && (
          <SkillBlock label="Preferred skills" skills={pref} categorised={prefIsCategorised} variant="preferred" catLabels={catLabels} catOrder={catOrder} />
        )}

        {/* Credentials & Eligibility */}
        {hasAnyCredentials(creds) && (
          <CredentialBlock credentials={creds!} />
        )}

        {/* Responsibilities */}
        {d.responsibilities && d.responsibilities.length > 0 && (
          <div>
            <h3 className="text-[10px] font-semibold uppercase tracking-widest text-text-3 mb-2">
              Responsibilities
            </h3>
            <ul className="space-y-1.5">
              {d.responsibilities.map((r, i) => (
                <li key={i} className="flex gap-2 text-[13px] text-text-2 leading-snug">
                  <span className="text-text-3 mt-0.5">•</span>
                  <span>{r}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function SkillBlock({
  label, skills, categorised, variant, catLabels, catOrder,
}: {
  label: string;
  skills: CategorisedSkills | string[];
  categorised: boolean;
  variant: "required" | "preferred";
  catLabels: Record<string, string>;
  catOrder: Cat[];
}) {
  return (
    <div>
      <h3 className="text-[10px] font-semibold uppercase tracking-widest text-text-3 mb-2">{label}</h3>
      {categorised ? (
        <CategorisedSkillGrid skills={skills as CategorisedSkills} variant={variant} catLabels={catLabels} catOrder={catOrder} />
      ) : (
        <FlatChips items={skills as string[]} variant={variant} />
      )}
    </div>
  );
}

function CategorisedSkillGrid({
  skills, variant, catLabels, catOrder,
}: {
  skills: CategorisedSkills;
  variant: "required" | "preferred";
  catLabels: Record<string, string>;
  catOrder: Cat[];
}) {
  const hasAny = catOrder.some((k) => (skills[k]?.length ?? 0) > 0);
  if (!hasAny) return null;

  return (
    <div className="space-y-2">
      {catOrder.map((cat) => {
        const items = skills[cat];
        if (!items || items.length === 0) return null;
        return (
          <div key={cat} className="flex flex-wrap items-start gap-x-2 gap-y-1.5">
            <span className="mt-0.5 shrink-0 text-[10px] font-semibold uppercase tracking-widest text-text-3 bg-surface-2 border border-border rounded px-1.5 py-0.5">
              {catLabels[cat]}
            </span>
            <div className="flex flex-wrap gap-1">
              {items.map((s) => <Chip key={s} label={s} variant={variant} />)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function CredentialBlock({ credentials }: { credentials: Credentials }) {
  const rows: { label: string; items: string[]; variant: "required" | "preferred" | "neutral" }[] = [];
  if (credentials.required?.length)    rows.push({ label: "Required",    items: credentials.required,    variant: "required"  });
  if (credentials.preferred?.length)   rows.push({ label: "Preferred",   items: credentials.preferred,   variant: "preferred" });
  if (credentials.eligibility?.length) rows.push({ label: "Eligibility", items: credentials.eligibility, variant: "neutral"   });
  if (rows.length === 0) return null;

  return (
    <div>
      <h3 className="text-[10px] font-semibold uppercase tracking-widest text-text-3 mb-2">
        Credentials &amp; Eligibility
      </h3>
      <div className="space-y-2">
        {rows.map(({ label, items, variant }) => (
          <div key={label} className="flex flex-wrap items-start gap-x-2 gap-y-1.5">
            <span className="mt-0.5 shrink-0 text-[10px] font-semibold uppercase tracking-widest text-text-3 bg-surface-2 border border-border rounded px-1.5 py-0.5">
              {label}
            </span>
            <div className="flex flex-wrap gap-1">
              {items.map((s) => <Chip key={s} label={s} variant={variant === "required" ? "required" : "preferred"} />)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function FlatChips({ items, variant }: { items: string[]; variant: "required" | "preferred" }) {
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((s, i) => <Chip key={i} label={s} variant={variant} />)}
    </div>
  );
}

function Chip({ label, variant }: { label: string; variant: "required" | "preferred" }) {
  const cls = variant === "required"
    ? "bg-[#DDF4FF] text-[var(--brand)] border-[var(--brand)]/20"
    : "bg-surface-2 text-text-2 border-border";
  return (
    <span className={`text-[11px] px-1.5 py-0.5 rounded border ${cls}`}>{label}</span>
  );
}

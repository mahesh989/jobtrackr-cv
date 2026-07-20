"use client";

import { useState } from "react";
import type { SkillCategory } from "@/lib/types";
import { SKILL_CATEGORY_LABELS } from "@/lib/types";
import { DisclosureButton } from "@/components/ui";

/**
 * Faithful port of cv-magic's FeasibilityCard with four buckets:
 *   - inject_directly      (CV literally supports it — used verbatim)
 *   - inject_as_extension  (reframed from existing achievements; Evidence + Suggested rewrite)
 *   - inject_with_inference (defensible inference chain; lower confidence)
 *   - cannot_inject        (honest gaps; will NOT be added to the tailored CV)
 *
 * Summary tiles at top mirror cv-magic exactly.
 */

type FeasibilityCategory = SkillCategory;

const CATEGORY_LABEL: Record<FeasibilityCategory, string> = SKILL_CATEGORY_LABELS;

interface BaseEntry {
  keyword:    string;
  category:   FeasibilityCategory;
  bucket?:    "required" | "preferred";
}
interface InjectDirectlyEntry  extends BaseEntry { evidence?: string; rationale?: string }
interface InjectExtensionEntry extends BaseEntry { evidence?: string; suggested_rewrite?: string }
interface InjectInferenceEntry extends BaseEntry {
  evidence?:        string;
  inferred_from?:   string[];
  inference_chain?: string;
  confidence?:      "low" | "medium" | "high";
  suggested_rewrite?: string;
}
interface CannotInjectEntry    extends BaseEntry { reason?: string }

interface FeasibilityPlan {
  inject_directly?:        InjectDirectlyEntry[];
  inject_as_extension?:    InjectExtensionEntry[];
  inject_with_inference?:  InjectInferenceEntry[];
  cannot_inject?:          CannotInjectEntry[];
  honest_gaps?:            CannotInjectEntry[];  // legacy alias
}

interface FeasibilitySummary {
  n_inject_directly?:       number;
  n_inject_as_extension?:   number;
  n_inject_with_inference?: number;
  n_cannot_inject?:         number;
  honest_gaps?:             number;
  expected_lift_pts?:       number;
}

interface FeasibilityData {
  feasibility_plan?: FeasibilityPlan;
  summary?:          FeasibilitySummary | string;
}

export function FeasibilityCard({ data }: { data: Record<string, unknown> }) {
  const d = data as FeasibilityData;
  const plan = d.feasibility_plan ?? {};
  const direct    = plan.inject_directly ?? [];
  const extension = plan.inject_as_extension ?? [];
  const inference = plan.inject_with_inference ?? [];
  const gaps      = plan.cannot_inject ?? plan.honest_gaps ?? [];

  const summaryObj = (d.summary && typeof d.summary === "object") ? d.summary as FeasibilitySummary : null;
  const summaryStr = typeof d.summary === "string" ? d.summary : null;

  const total = direct.length + extension.length + inference.length + gaps.length;
  if (total === 0 && !summaryObj && !summaryStr) return null;

  return (
    <div className="bg-surface border border-border rounded-md overflow-hidden">
      <div className="px-5 py-3 border-b border-border bg-surface-2">
        <h2 className="text-[14px] font-semibold text-text">Keyword feasibility plan</h2>
      </div>
      <div className="px-5 py-4 space-y-4">
        {summaryObj && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
            <SummaryStat label="Direct adds"    value={summaryObj.n_inject_directly       ?? direct.length}    tone="green"  />
            <SummaryStat label="Reword bullets" value={summaryObj.n_inject_as_extension   ?? extension.length} tone="blue"   />
            <SummaryStat label="From inference" value={summaryObj.n_inject_with_inference ?? inference.length} tone="violet" />
            <SummaryStat label="Honest gaps"    value={summaryObj.n_cannot_inject ?? summaryObj.honest_gaps ?? gaps.length} tone="amber" />
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

        <Bucket
          title="Inject directly"
          subtitle="Strong CV evidence — added verbatim to the tailored CV."
          tone="green"
          count={direct.length}
        >
          {direct.map((e, i) => <DirectEntry key={i} e={e} />)}
        </Bucket>

        <Bucket
          title="Inject as extension"
          subtitle="Reframed from existing achievements — bullets are reworded, not invented."
          tone="blue"
          count={extension.length}
        >
          {extension.map((e, i) => <ExtensionEntry key={i} e={e} />)}
        </Bucket>

        <Bucket
          title="Inferred from adjacent evidence"
          subtitle="Not in your CV literally, but technically implied by what you did. Defensible in interview — review the inference chain before sending."
          tone="violet"
          count={inference.length}
          defaultOpen={false}
        >
          {inference.map((e, i) => <InferenceEntry key={i} e={e} />)}
        </Bucket>

        <Bucket
          title="Honest gaps"
          subtitle="No CV evidence — these will NOT appear in your tailored CV. Consider real upskilling."
          tone="amber"
          count={gaps.length}
        >
          {gaps.map((e, i) => <GapEntry key={i} e={e} />)}
        </Bucket>
      </div>
    </div>
  );
}

// ── Building blocks ────────────────────────────────────────────────────────

type Tone = "green" | "blue" | "violet" | "amber" | "gray";

// Token-based so they read correctly on every theme (dark + light). On dark
// the /12 tint is a subtle wash and the bright token text pops; on light the
// tint is pale and the darker token text reads — same as the matched/missing
// keyword chips.
const TONE_CHIP: Record<Tone, string> = {
  green:  "bg-[var(--green)]/12 text-green border-[var(--green)]/30",
  blue:   "bg-[var(--brand)]/12 text-[var(--brand)] border-[var(--brand)]/30",
  violet: "bg-[var(--purple)]/12 text-[var(--purple)] border-[var(--purple)]/30",
  amber:  "bg-[var(--amber)]/12 text-[var(--amber)] border-[var(--amber)]/40",
  gray:   "bg-surface-2 text-text-2 border-border",
};
const TONE_REWRITE: Record<Tone, string> = {
  green:  "bg-[var(--green)]/8 text-text",
  blue:   "bg-[var(--brand)]/8 text-text",
  violet: "bg-[var(--purple)]/8 text-text",
  amber:  "bg-[var(--amber)]/8 text-text",
  gray:   "bg-surface-2 text-text-2",
};

function SummaryStat({
  label, value, tone,
}: {
  label: string;
  value: number | string;
  tone: Tone;
}) {
  return (
    <div className="bg-surface-2 border border-border rounded p-2">
      <div className="text-[10px] uppercase tracking-wide text-text-3">{label}</div>
      <div className={`mt-1 inline-block text-[14px] font-bold tabular-nums px-2 py-0.5 rounded border ${TONE_CHIP[tone]}`}>
        {value}
      </div>
    </div>
  );
}

function Bucket({
  title, subtitle, tone, count, defaultOpen, children,
}: {
  title: string;
  subtitle: string;
  tone: Tone;
  count: number;
  defaultOpen?: boolean;
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen ?? (count > 0 && tone !== "violet"));
  return (
    <div className="border border-border rounded-md">
      <DisclosureButton
        open={open}
        onToggle={() => setOpen((v) => !v)}
        className="hover:bg-surface-2/50"
        title={<>{title} <span className={`text-[11px] font-semibold px-1.5 py-0.5 rounded border ${TONE_CHIP[tone]}`}>{count}</span></>}
        subtitle={subtitle}
      />
      {open && count > 0 && (
        <div className="border-t border-border bg-surface-2/30 p-2.5 space-y-2">
          {children}
        </div>
      )}
      {open && count === 0 && (
        <div className="border-t border-border px-3 py-2 text-[11px] italic text-text-3">None.</div>
      )}
    </div>
  );
}

function HeaderRow({ entry, extras }: { entry: BaseEntry; extras?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[12px] font-semibold font-mono text-text">{entry.keyword}</span>
      <span className="text-[10px] uppercase tracking-wide text-text-3 bg-surface border border-border rounded px-1.5 py-0.5">
        {CATEGORY_LABEL[entry.category]}
      </span>
      {entry.bucket === "preferred" && (
        <span className="text-[10px] uppercase tracking-wide text-text-3 bg-surface border border-border rounded px-1.5 py-0.5">
          Preferred
        </span>
      )}
      {extras}
    </div>
  );
}

function DirectEntry({ e }: { e: InjectDirectlyEntry }) {
  return (
    <div className="border border-border bg-surface rounded p-2.5">
      <HeaderRow entry={e} />
      {e.evidence && (
        <p className="mt-1.5 text-[11px] text-text-3">
          <span className="font-medium text-text">Evidence:</span>{" "}
          <span className="italic">&ldquo;{e.evidence}&rdquo;</span>
        </p>
      )}
      {e.rationale && (
        <p className="mt-1 text-[11px] text-text-3 leading-snug">{e.rationale}</p>
      )}
    </div>
  );
}

function ExtensionEntry({ e }: { e: InjectExtensionEntry }) {
  return (
    <div className="border border-border bg-surface rounded p-2.5">
      <HeaderRow entry={e} />
      {e.evidence && (
        <p className="mt-1.5 text-[11px] text-text-3">
          <span className="font-medium text-text">Evidence:</span>{" "}
          <span className="italic">&ldquo;{e.evidence}&rdquo;</span>
        </p>
      )}
      {e.suggested_rewrite && (
        <p className={`mt-2 rounded p-2 text-[11px] leading-snug ${TONE_REWRITE.blue}`}>
          <span className="font-medium">Suggested rewrite:</span>{" "}
          {e.suggested_rewrite}
        </p>
      )}
    </div>
  );
}

function InferenceEntry({ e }: { e: InjectInferenceEntry }) {
  return (
    <div className="border border-border bg-surface rounded p-2.5">
      <HeaderRow
        entry={e}
        extras={
          e.confidence && (
            <span className={`text-[10px] uppercase tracking-wide font-semibold rounded px-1.5 py-0.5 border ${
              e.confidence === "high"
                ? "bg-[var(--purple)]/12 text-[var(--purple)] border-[var(--purple)]/30"
                : "bg-[var(--purple)]/8 text-[var(--purple)]/80 border-[var(--purple)]/20"
            }`}>
              {e.confidence} confidence
            </span>
          )
        }
      />
      {e.evidence && (
        <p className="mt-1.5 text-[11px] text-text-3">
          <span className="font-medium text-text">Evidence:</span>{" "}
          <span className="italic">&ldquo;{e.evidence}&rdquo;</span>
        </p>
      )}
      {e.inferred_from && e.inferred_from.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          <span className="text-[11px] font-medium text-text">Inferred from:</span>
          {e.inferred_from.map((src, i) => (
            <span key={`${src}-${i}`} className="text-[10px] px-1.5 py-0.5 rounded border bg-[var(--purple)]/12 text-[var(--purple)] border-[var(--purple)]/25">
              {src}
            </span>
          ))}
        </div>
      )}
      {e.inference_chain && (
        <p className="mt-1.5 text-[11px] text-text-3 leading-snug">
          <span className="font-medium text-text">Reasoning:</span>{" "}
          {e.inference_chain}
        </p>
      )}
      {e.suggested_rewrite && (
        <p className={`mt-2 rounded p-2 text-[11px] leading-snug ${TONE_REWRITE.violet}`}>
          <span className="font-medium">Suggested rewrite:</span>{" "}
          {e.suggested_rewrite}
        </p>
      )}
    </div>
  );
}

function GapEntry({ e }: { e: CannotInjectEntry }) {
  return (
    <div className="border border-border bg-surface rounded p-2.5">
      <HeaderRow entry={e} />
      {e.reason && (
        <p className="mt-1.5 text-[11px] text-text-3 leading-snug">{e.reason}</p>
      )}
    </div>
  );
}

"use client";

/**
 * Job description tab — the detail pane's default/first tab.
 *
 * Renders the structured JD analysis (title/seniority/domain badges,
 * categorised required/preferred skills, credentials, responsibilities) when
 * an analysis run exists. Falls back to the raw scraped/manual description
 * for not-yet-analysed or needs-JD jobs. Surfaces a failed-run explanation
 * when the last run errored before producing anything.
 */

import { Loader2 } from "lucide-react";
import { SKILL_CATEGORY_LABELS, type SkillCategory } from "@/lib/types";
import type { BoardJob } from "../../lib/jobFilters";
import type { BoardDetailPayload } from "../../lib/boardDetailTypes";
import { CAT_ORDER } from "../../lib/boardDetailTypes";
import { MANUAL_JD_MIN_CHARS } from "../../lib/jobFilters";

function toCategorised(v: string[] | Record<string, string[]> | undefined): Record<string, string[]> {
  if (!v) return {};
  if (Array.isArray(v)) return { domain_knowledge: v };
  return v;
}

export function JobDescriptionTab({
  job, detail, loading = false,
}: {
  job: BoardJob;
  detail: BoardDetailPayload | null;
  /** True while the pane's board-detail payload is still in flight. */
  loading?: boolean;
}) {
  const run = detail?.run ?? null;

  // The structured JD lives in the fetched payload, but the raw description is
  // already on the board row — so rendering "no analysis yet" logic against a
  // null payload showed every analysed job its raw scraped ad for the length of
  // the fetch, then swapped it for the structured view. `has_analysis` is known
  // up front, so wait for the real thing rather than flashing the wrong one.
  if (loading && !detail && job.progress.has_analysis) {
    return (
      <div className="flex items-center gap-2 py-6 text-label text-text-3">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading…
      </div>
    );
  }

  if (run?.status === "failed") {
    return (
      <div className="space-y-4">
        <div className="rounded-[10px] bg-red-light border border-red/20 px-3.5 py-2.5">
          <p className="text-[14px] text-red leading-relaxed">
            The last analysis failed before it could start{run.error_message ? ` (${run.error_message})` : ""}. Nothing was scored. This usually clears on retry.
          </p>
        </div>
        <RawDescription detail={detail} loading={loading} />
      </div>
    );
  }

  const jd = run?.jd_analysis_result;
  if (!jd) {
    return (
      <div className="space-y-4">
        {(job.jd_quality === "thin" || job.jd_quality === "unknown") && (
          <div className="rounded-[10px] bg-amber-light border border-amber/20 px-3.5 py-2.5">
            <p className="text-[14px] text-warning leading-relaxed">
              {job.jd_quality === "thin"
                ? `Only a short description was scraped — too little to analyse reliably. Paste the full ad and analysis runs automatically once it's ${MANUAL_JD_MIN_CHARS}+ characters.`
                : "We couldn't retrieve a description from this listing — it may require JavaScript to load. Paste the description manually to unlock analysis."}
            </p>
          </div>
        )}
        <RawDescription detail={detail} loading={loading} />
      </div>
    );
  }

  const order = (jd.category_order ?? CAT_ORDER) as SkillCategory[];
  const labels = jd.category_labels ?? SKILL_CATEGORY_LABELS;
  const required  = toCategorised(jd.required_skills as string[] | Record<string, string[]> | undefined);
  const preferred = toCategorised(jd.preferred_skills as string[] | Record<string, string[]> | undefined);
  const hasPreferred = order.some((c) => (preferred[c]?.length ?? 0) > 0);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-1.5">
        {jd.seniority_level && (
          <span className="inline-block text-[10.5px] font-bold uppercase tracking-wider px-[9px] py-[3px] rounded-[6px] bg-[var(--purple-light)] text-[var(--purple)]">{jd.seniority_level}</span>
        )}
        {jd.job_context?.setting && (
          <span className="inline-block text-[10.5px] font-bold uppercase tracking-wider px-[9px] py-[3px] rounded-[6px] bg-green-light text-success">{jd.job_context.setting.replace(/_/g, " ")}</span>
        )}
        {typeof jd.experience_years_required === "number" && (
          <span className="inline-block text-[10.5px] font-bold uppercase tracking-wider px-[9px] py-[3px] rounded-[6px] bg-[var(--surface-2)] text-text-2">{jd.experience_years_required}+ yrs</span>
        )}
      </div>

      {jd.summary && <p className="text-[15px] text-text leading-relaxed">{jd.summary}</p>}

      <div>
        <h4 className="text-[12px] font-bold uppercase tracking-wide text-text mb-2">Required skills</h4>
        <div className="space-y-2">
          {order.filter((c) => (required[c]?.length ?? 0) > 0).map((c) => (
            <div key={c}>
              <p className="text-[11px] font-bold text-text-3 uppercase tracking-wider mb-1">{labels[c] ?? c}</p>
              <div className="flex flex-wrap gap-1">
                {required[c].map((kw) => (
                  <span key={kw} className="inline-block text-[12.5px] px-[11px] py-[4px] rounded-[20px] mr-1 mb-1 bg-[var(--surface-2)] text-text-2">{kw}</span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <h4 className="text-[12px] font-bold uppercase tracking-wide text-text mb-2">Preferred skills</h4>
        {hasPreferred ? (
          <div className="space-y-2">
            {order.filter((c) => (preferred[c]?.length ?? 0) > 0).map((c) => (
              <div key={c} className="flex flex-wrap gap-1">
                {preferred[c].map((kw) => (
                  <span key={kw} className="inline-block text-[12.5px] px-[11px] py-[4px] rounded-[20px] mr-1 mb-1 bg-[var(--surface-2)] text-text-2">{kw}</span>
                ))}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[13px] text-text-3 italic">None listed in this job.</p>
        )}
      </div>

      {(jd.credentials?.required?.length || jd.credentials?.eligibility?.length) ? (
        <div>
          <h4 className="text-[12px] font-bold uppercase tracking-wide text-text mb-2">Credentials &amp; eligibility</h4>
          {jd.credentials?.required?.length ? (
            <p className="text-[13px] text-text-2 mb-1">
              <span className="font-bold text-text-3 uppercase text-[11px] mr-1">Required</span>
              {jd.credentials.required.join(" · ")}
            </p>
          ) : null}
          {jd.credentials?.eligibility?.length ? (
            <p className="text-[13px] text-text-2">
              <span className="font-bold text-text-3 uppercase text-[11px] mr-1">Eligibility</span>
              {jd.credentials.eligibility.join(" · ")}
            </p>
          ) : null}
        </div>
      ) : null}

      {jd.responsibilities?.length ? (
        <div>
          <h4 className="text-[12px] font-bold uppercase tracking-wide text-text mb-2">Responsibilities</h4>
          <ul className="list-disc pl-5 space-y-1 text-[14px] text-text-2">
            {jd.responsibilities.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function RawDescription({
  detail, loading,
}: {
  detail: BoardDetailPayload | null;
  loading?: boolean;
}) {
  // The JD text now arrives with the per-job payload rather than on the board
  // row, so "not here yet" and "genuinely empty" are different states — without
  // this guard every job would flash "No description available" for the length
  // of the fetch.
  if (loading && !detail) {
    return (
      <div className="flex items-center gap-2 py-6 text-label text-text-3">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading…
      </div>
    );
  }
  const text = (detail?.manual_jd_text ?? detail?.description ?? "").trim();
  if (!text) return <p className="text-label text-text-3 italic">No description available.</p>;
  return <p className="text-[15px] text-text whitespace-pre-wrap leading-relaxed">{text}</p>;
}

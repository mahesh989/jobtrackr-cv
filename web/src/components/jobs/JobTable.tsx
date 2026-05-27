"use client";

/**
 * Canonical job-board table.
 *
 * Renders a 12-col grid: Role · Company · Source · Posted · Added ·
 * Progress · (Visa) · Actions. The Progress column shows 4 inline
 * icons per row — Analysed, Tailored CV, Cover Letter, Applied —
 * filled when done, outlined otherwise. Clicking a "done" icon
 * navigates to the relevant artefact.
 *
 * Row-level interactions:
 *   - Click row body  → expand/collapse description
 *   - Apply/Dismiss   → flash-and-collapse exit animation
 *   - Edit JD         → modal (JobEditModal)
 *   - ⋮ menu          → Edit JD / View analysis / Mark applied / Dismiss
 *
 * Data shape: each job must carry a `progress` field derived by
 * deriveProgress() in progressFlags.ts.
 */

import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { BarChart3, FileText, Mail, CheckCircle2, FileWarning, FileQuestion } from "lucide-react";
import { markJobApplied, markJobDismissed } from "@/lib/actions";
import { AnalyzeJobButton } from "@/components/cv/AnalyzeJobButton";
import { JobEditModal } from "@/components/cv/JobEditModal";
import type { JobProgress } from "./progressFlags";
import { useJobBoardSettings } from "./JobBoardSettings";
import { PIPELINE_STATE_META, TONE_CLASSES, type PipelineState } from "./pipelineState";

export interface Job {
  id:                  string;
  profile_id:          string;
  url:                 string;
  title:               string;
  company:             string;
  location:            string;
  description:         string;
  source:              string;
  source_tier:         number;
  posted_at:           string | null;
  created_at:          string;
  salary_min?:         number;
  salary_max?:         number;
  visa_likelihood:     number | null;
  sponsorship_status:  "yes" | "no" | "not_mentioned" | null;
  citizen_pr_only:     boolean | null;
  visa_extracted_text: string | null;
  keywords_matched:    string[];
  applied_at:          string | null;
  dismissed_at:        string | null;
  is_dead_link:        boolean;
  seen_at:             string | null;
  dedup_status?:       string | null;
  manual_jd_text?:     string | null;
  contact_email?:      string | null;
  hiring_manager?:     string | null;
  company_address?:    string | null;
  /** Set on the unified dashboard board (all profiles) — undefined on
   * per-profile boards where the profile context is already obvious. */
  profile_name?:       string | null;
  // Phase A signals (backfilled for existing jobs, set during scraping
  // for new jobs once Phase C lands).
  jd_quality?:         "rich" | "thin" | "unknown" | null;
  role_match?:         "match" | "mismatch" | "uncertain" | null;
  has_email?:          boolean | null;
  /** Driving distance from the profile's home_address. Null when no
   *  home_address is set, or the job location couldn't be geocoded. */
  distance_km?:        number | null;
  /** 'driving' = OSRM route; 'haversine' = straight-line fallback (UI
   *  renders ~ prefix and a tooltip explaining the approximation). */
  distance_method?:    "driving" | "haversine" | null;
  /** Derived in page.tsx via progressFlags.deriveProgress(). */
  progress:            JobProgress;
  /** Derived in page.tsx via pipelineState.derivePipelineState(). */
  pipelineState?:      PipelineState;
}

function relativeDate(d: string | null) {
  if (!d) return null;
  const diff = Date.now() - new Date(d).getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7)  return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function relativeAdded(d: string | null) {
  if (!d) return null;
  const then = new Date(d);
  const now  = new Date();
  const startOfToday = new Date(now.getFullYear(),  now.getMonth(),  now.getDate());
  const startOfThen  = new Date(then.getFullYear(), then.getMonth(), then.getDate());
  const dayDiff = Math.round((startOfToday.getTime() - startOfThen.getTime()) / 86400000);
  if (dayDiff === 0) return then.toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (dayDiff === 1) return "Yesterday";
  if (dayDiff < 7)   return `${dayDiff}d`;
  if (dayDiff < 30)  return `${Math.floor(dayDiff / 7)}w`;
  return `${Math.floor(dayDiff / 30)}mo`;
}

function formatSalary(min?: number | null, max?: number | null) {
  if (!min && !max) return null;
  const ref = max || min || 0;
  const period = ref < 200 ? "/hr" : ref < 3000 ? "/day" : "/yr";
  const fmt = (v: number) =>
    period === "/yr" ? `$${Math.round(v / 1000)}k` : `$${Math.round(v).toLocaleString()}`;
  if (min && max && min !== max) return `${fmt(min)}–${fmt(max)}${period}`;
  return `${fmt((min || max)!)}${period}`;
}

/** Banded colour for the distance chip — green ≤10, neutral ≤25, amber ≤50, red >50. */
function distanceTone(km: number): string {
  if (km <= 10) return "text-green-600";
  if (km <= 25) return "text-text-2";
  if (km <= 50) return "text-amber-600";
  return "text-red-600";
}

function DistanceChip({ km, method }: { km: number; method: "driving" | "haversine" | null | undefined }) {
  const approx = method === "haversine";
  const display = `${approx ? "~" : ""}${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
  const title = approx
    ? "Straight-line estimate — OSRM had no driving route for this address"
    : "Driving distance from your home address";
  return (
    <span title={title} className={`inline-flex items-center text-[10px] font-medium tabular-nums shrink-0 ${distanceTone(km)}`}>
      · {display}
    </span>
  );
}

function sourceBadge(source: string) {
  const map: Record<string, string> = {
    adzuna: "badge-blue", greenhouse: "badge-purple", lever: "badge-purple",
    pageup: "badge-amber", workday: "badge-teal", smartrecruiters: "badge-green",
    ashby: "badge-purple", jobadder: "badge-amber", seek: "badge-blue",
    indeed: "badge-amber", careerjet: "badge-teal",
  };
  return map[source.toLowerCase()] ?? "badge-gray";
}

type ExitPhase = "idle" | "flash" | "fading" | "gone";

/** A named group of jobs rendered with a banner row inside the table. Used by
 *  the dashboard's smart-feed view to interleave headings like "Today's picks"
 *  / "Closest to you" between rows without losing the table chrome. When the
 *  table is called without `sections` (the per-profile board, every other
 *  caller) the rendering is byte-identical to the pre-2026-05-28 behaviour. */
export interface JobTableSection {
  /** Short label for the banner. */
  label: string;
  /** Short caption beneath/right of the label (e.g. "Within 15 km"). */
  caption?: string;
  /** Visual accent — picks the icon and the tinted banner colour. */
  tone?: "brand" | "green" | "amber" | "muted";
  /** Lucide icon component. */
  icon?: typeof BarChart3;
  /** Jobs in this section, already in display order. */
  jobs: Job[];
}

export function JobTable({ jobs, showVisa, currentTab, sections }: {
  jobs:       Job[];
  showVisa:   boolean;
  currentTab: string;
  /** Optional grouped view — see JobTableSection. When omitted, renders flat. */
  sections?:  JobTableSection[];
}) {
  const settings = useJobBoardSettings();

  // Flat-mode empty state (preserves the original behaviour).
  if (!sections && jobs.length === 0) {
    return (
      <div className="bg-surface border border-border rounded-md">
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="w-12 h-12 rounded-lg bg-[var(--surface-2)] border border-border flex items-center justify-center mb-4">
            <svg className="w-5 h-5 text-text-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"/>
            </svg>
          </div>
          <p className="text-[14px] font-semibold text-text mb-1">No jobs match your filters</p>
          <p className="text-[12px] text-text-2">Adjust the filters above or run the pipeline to fetch new listings.</p>
        </div>
      </div>
    );
  }

  // Anim-delay must keep counting across section banners so the cascade reads
  // top→bottom regardless of how the rows are grouped.
  let animCursor = 0;

  return (
    <div className="bg-surface border border-border rounded-md overflow-hidden">
      <div className="grid grid-cols-12 gap-2 px-4 py-2.5 bg-[var(--surface-2)] border-b border-border text-[11px] font-semibold text-text-2 uppercase tracking-wider">
        <div className="col-span-3">Role</div>
        <div className="col-span-2">Company</div>
        <div className="col-span-1 text-center">Source</div>
        <div className="col-span-1 text-center">Posted</div>
        <div className="col-span-1 text-center">Added</div>
        <div className="col-span-1 text-center">{settings.showProgressColumnLabel ? "Progress" : ""}</div>
        {showVisa && <div className="col-span-1 text-center">Visa</div>}
        <div className={`${showVisa ? "col-span-2" : "col-span-3"} text-right`}>Actions</div>
      </div>

      {sections
        ? sections.flatMap((sec, sIdx) => {
            const items: React.ReactNode[] = [];
            if (sec.jobs.length === 0) return items;
            items.push(
              <SectionBanner key={`sec-hdr-${sIdx}`} section={sec} />,
            );
            for (const job of sec.jobs) {
              const i = animCursor++;
              items.push(
                <JobRow
                  key={job.id}
                  job={job}
                  showVisa={showVisa}
                  animDelay={Math.min(i, 5)}
                  currentTab={currentTab}
                />,
              );
            }
            return items;
          })
        : jobs.map((job, i) => (
            <JobRow
              key={job.id}
              job={job}
              showVisa={showVisa}
              animDelay={Math.min(i, 5)}
              currentTab={currentTab}
            />
          ))}
    </div>
  );
}

/** Section header rendered inline between rows. Spans the full table width so
 *  it visually breaks the list without disturbing column alignment. */
function SectionBanner({ section }: { section: JobTableSection }) {
  const tone = section.tone ?? "muted";
  const toneCls: Record<typeof tone, { bg: string; text: string; dot: string }> = {
    brand: { bg: "bg-[#DDF4FF]",         text: "text-[var(--brand)]", dot: "bg-[var(--brand)]" },
    green: { bg: "bg-green-50",          text: "text-green-700",       dot: "bg-green-500"     },
    amber: { bg: "bg-amber-50",          text: "text-amber-700",       dot: "bg-amber-500"     },
    muted: { bg: "bg-[var(--surface-2)]", text: "text-text-2",         dot: "bg-text-3"        },
  };
  const t = toneCls[tone];
  const Icon = section.icon;
  return (
    <div className={`flex items-center gap-2 px-4 py-2 border-b border-border ${t.bg}`}>
      {Icon
        ? <Icon className={`w-3.5 h-3.5 ${t.text}`} />
        : <span className={`w-1.5 h-1.5 rounded-full ${t.dot}`} />}
      <span className={`text-[12px] font-semibold uppercase tracking-wider ${t.text}`}>
        {section.label}
      </span>
      <span className="text-[11px] font-medium text-text-3 tabular-nums">
        {section.jobs.length}
      </span>
      {section.caption && (
        <span className="text-[11px] text-text-3 truncate">— {section.caption}</span>
      )}
    </div>
  );
}

function JobRow({ job, showVisa, animDelay, currentTab }: {
  job:        Job;
  showVisa:   boolean;
  animDelay:  number;
  currentTab: string;
}) {
  const settings = useJobBoardSettings();
  const [expanded, setExpanded]     = useState(false);
  const [isPending, setIsPending]   = useState(false);
  const [localApplied, setLocalApplied] = useState(!!job.applied_at);
  const [exitPhase, setExitPhase]   = useState<ExitPhase>("idle");
  const [showEdit, setShowEdit]     = useState(false);
  const [manualJd, setManualJd]     = useState<string | null>(job.manual_jd_text ?? null);
  const [contactEmail, setContactEmail] = useState<string | null>(job.contact_email ?? null);
  const [hiringMgr, setHiringMgr]   = useState<string | null>(job.hiring_manager ?? null);
  const [companyAddress, setCompanyAddress] = useState<string | null>(job.company_address ?? null);

  const salary    = formatSalary(job.salary_min, job.salary_max);
  const postedAgo = relativeDate(job.posted_at || job.created_at);
  const isNew     = !job.seen_at && !localApplied && exitPhase === "idle";
  const isFlash   = exitPhase === "flash";
  const isFading  = exitPhase === "fading";
  const isDismissed = !!job.dismissed_at;
  const hideProgress = isDismissed && settings.hideProgressOnDismissed;

  async function handleApply(e: React.MouseEvent) {
    e.stopPropagation();
    if (localApplied || exitPhase !== "idle" || isPending) return;
    setLocalApplied(true);
    setIsPending(true);
    if (currentTab !== "applied") {
      setExitPhase("flash");
      setTimeout(() => setExitPhase("fading"), 700);
      setTimeout(() => setExitPhase("gone"), 1150);
    }
    try { await markJobApplied(job.id, job.profile_id); }
    catch (err) {
      console.error("[JobRow] markJobApplied failed:", err);
      setLocalApplied(false); setExitPhase("idle");
    } finally { setIsPending(false); }
  }

  async function handleDismiss(e: React.MouseEvent) {
    e.stopPropagation();
    if (exitPhase !== "idle" || isPending) return;
    setIsPending(true);
    setExitPhase("fading");
    setTimeout(() => setExitPhase("gone"), 450);
    try { await markJobDismissed(job.id, job.profile_id); }
    catch (err) {
      console.error("[JobRow] markJobDismissed failed:", err);
      setExitPhase("idle");
    } finally { setIsPending(false); }
  }

  if (exitPhase === "gone") return null;

  return (
    <div
      style={{
        display: "grid",
        gridTemplateRows: isFading ? "0fr" : "1fr",
        opacity: isFading ? 0 : 1,
        transition: isFading ? "grid-template-rows 420ms ease, opacity 280ms ease" : undefined,
        overflow: "hidden",
        pointerEvents: exitPhase !== "idle" ? "none" : undefined,
      }}
    >
      <div style={{ overflow: "hidden" }}>
        <div
          className={`grid grid-cols-12 gap-2 px-4 py-3 border-b border-border last:border-0 cursor-pointer anim-in anim-delay-${animDelay} transition-colors ${
            isFlash ? "bg-green-light" : "hover:bg-[var(--surface-2)]/60"
          } ${
            localApplied ? "border-l-2 border-l-green" : isNew ? "border-l-2 border-l-[var(--brand)]" : ""
          }`}
          onClick={() => setExpanded(!expanded)}
        >
          {/* Role (col-span-3) */}
          <div className="col-span-3 flex items-start gap-2.5 min-w-0">
            <div className="w-6 h-6 rounded bg-[var(--surface-2)] border border-border flex items-center justify-center shrink-0 mt-0.5">
              <span className="text-[11px] font-bold text-text-2">
                {job.company?.[0]?.toUpperCase() ?? "?"}
              </span>
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                {isNew && (
                  <span className="badge badge-blue text-[10px] px-1.5 h-4 font-bold">NEW</span>
                )}
                {/* Pipeline state badge — single source for lifecycle position.
                    Hidden when state == discovered (the default — nothing to say). */}
                {job.pipelineState && (() => {
                  const meta = PIPELINE_STATE_META[job.pipelineState];
                  if (!meta.showAsBadge) return null;
                  const tone = TONE_CLASSES[meta.tone];
                  return (
                    <span
                      title={meta.short}
                      className={`inline-flex items-center gap-1 text-[10px] px-1.5 h-4 rounded font-medium border ${tone.pill}`}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full ${tone.dot}`} />
                      {meta.label}
                    </span>
                  );
                })()}
                {job.is_dead_link && (
                  <span className="badge badge-red text-[10px] px-1.5 h-4">Dead link</span>
                )}
              </div>
              <a
                href={job.url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="text-[13px] font-semibold text-text hover:text-[var(--brand)] transition-colors leading-snug block truncate"
              >
                {job.title}
              </a>
              {job.dedup_status === "possible_duplicate" && (
                <span
                  title="This job looks similar to another listing in your feed — same title and company in a different city. Click Hide if it's a duplicate."
                  className="inline-block mt-0.5 text-[10px] px-1.5 py-0.5 rounded bg-[#FFF8C5] text-[#9A6700] border border-[#FAE17D] font-medium"
                >
                  Possible duplicate
                </span>
              )}
              {(job.location || job.jd_quality === "thin" || job.jd_quality === "unknown") && (
                <p className="text-[11px] text-text-3 truncate mt-0.5 flex items-center gap-1.5">
                  {job.location && <span className="truncate">{job.location}</span>}
                  {typeof job.distance_km === "number" && (
                    <DistanceChip km={job.distance_km} method={job.distance_method ?? null} />
                  )}
                  {/* JD-quality indicator — only shown for problems, not for 'rich' */}
                  {job.jd_quality === "thin" && (
                    <span
                      title="JD too short to analyse — click Edit JD to paste the full description"
                      className="inline-flex items-center gap-0.5 text-amber-600 shrink-0"
                    >
                      <FileWarning className="w-3 h-3" />
                      <span className="text-[10px] font-medium">thin JD</span>
                    </span>
                  )}
                  {job.jd_quality === "unknown" && (
                    <span
                      title="JD may be incomplete — review or paste the full description if analysis is off"
                      className="inline-flex items-center gap-0.5 text-text-3 shrink-0"
                    >
                      <FileQuestion className="w-3 h-3" />
                    </span>
                  )}
                </p>
              )}
              {job.profile_name && (
                <p className="text-[10px] text-text-3 truncate mt-0.5 italic opacity-80" title={`Found via "${job.profile_name}" search`}>
                  via {job.profile_name}
                </p>
              )}
              {(manualJd || contactEmail) && (
                <div className="flex flex-wrap items-center gap-3 mt-1 text-xs">
                  {manualJd && (
                    <span className="font-semibold text-green-600" title="JD has been manually trimmed for AI analysis">Edited JD</span>
                  )}
                  {contactEmail && (
                    <span className="font-semibold text-[var(--brand)]" title={contactEmail}>✉ Email</span>
                  )}
                </div>
              )}
              {(job.keywords_matched?.length ?? 0) > 0 && (
                <div className="flex flex-wrap gap-1 mt-1">
                  {job.keywords_matched.slice(0, 3).map((kw) => (
                    <span key={kw} className="badge badge-gray text-[10px] px-1.5 h-4">{kw}</span>
                  ))}
                  {job.keywords_matched.length > 3 && (
                    <span className="text-[10px] text-text-3">+{job.keywords_matched.length - 3}</span>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Company */}
          <div className="col-span-2 flex items-center min-w-0">
            <div className="min-w-0">
              <p className="text-[12px] font-medium text-text truncate">{job.company || "—"}</p>
              {salary && (
                <p className="text-[11px] text-[#1A7F37] font-medium">{salary}</p>
              )}
            </div>
          </div>

          {/* Source */}
          <div className="col-span-1 flex items-center justify-center">
            <span className={`badge ${sourceBadge(job.source)} text-[10px] px-1.5 h-4 capitalize`}>
              {job.source}
            </span>
          </div>

          {/* Posted */}
          <div className="col-span-1 flex items-center justify-center">
            <span className="text-[11px] text-text-3">{postedAgo ?? "—"}</span>
          </div>

          {/* Added */}
          <div className="col-span-1 flex items-center justify-center">
            <span className="text-[11px] text-text-3">{relativeAdded(job.created_at) ?? "—"}</span>
          </div>

          {/* Progress */}
          <div className="col-span-1 flex items-center justify-center" onClick={(e) => e.stopPropagation()}>
            {hideProgress ? (
              <span className="text-[10px] text-text-3">—</span>
            ) : (
              <ProgressIcons job={job} dimmed={isDismissed} />
            )}
          </div>

          {/* Visa (conditional) */}
          {showVisa && (
            <div className="col-span-1 flex items-center justify-center">
              <VisaBadge
                sponsorship={job.sponsorship_status}
                citizenPROnly={job.citizen_pr_only}
                extractedText={job.visa_extracted_text}
              />
            </div>
          )}

          {/* Actions */}
          <div
            className={`${showVisa ? "col-span-2" : "col-span-3"} relative flex items-center justify-end gap-1.5`}
            onClick={(e) => e.stopPropagation()}
          >
            <AnalyzeJobButton jobId={job.id} hasAnalysis={job.progress.has_analysis} />
            <RowMenu
              job={job}
              pending={isPending}
              onEdit={() => setShowEdit(true)}
              onDismiss={handleDismiss}
            />
          </div>
        </div>

        {expanded && (
          <div className="border-b border-border bg-[var(--surface-2)] px-4 py-4">
            <p className="text-[12px] text-text leading-relaxed whitespace-pre-wrap break-words max-w-3xl">
              {(job.description || "No description available.").slice(0, 600)}
              {(job.description || "").length > 600 ? "…" : ""}
            </p>
            <a
              href={job.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 mt-3 text-[12px] font-medium text-[var(--brand)] hover:underline"
            >
              View full posting
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/>
              </svg>
            </a>
          </div>
        )}
      </div>

      {showEdit && (
        <JobEditModal
          jobId={job.id}
          originalJd={job.description ?? ""}
          initialManual={manualJd}
          initialEmail={contactEmail}
          initialHiringMgr={hiringMgr}
          initialCompanyAddress={companyAddress}
          onClose={() => setShowEdit(false)}
          onSaved={(patch) => {
            setManualJd(patch.manual_jd_text);
            setContactEmail(patch.contact_email);
            setHiringMgr(patch.hiring_manager);
            setCompanyAddress(patch.company_address);
          }}
        />
      )}
    </div>
  );
}

// ── Progress icons ───────────────────────────────────────────────────────────
function ProgressIcons({ job, dimmed }: { job: Job; dimmed: boolean }) {
  const p = job.progress;
  const baseDone = `w-3.5 h-3.5 ${dimmed ? "opacity-50" : ""}`;
  const baseOff  = `w-3.5 h-3.5 opacity-30`;

  const analysisHref = p.latest_run_id ? `/dashboard/jobs/${job.id}/analyze/${p.latest_run_id}` : null;

  const Icon = ({ on, doneClass, offClass, IconCmp, label, href }: {
    on:        boolean;
    doneClass: string;
    offClass:  string;
    IconCmp:   typeof BarChart3;
    label:     { on: string; off: string };
    href:      string | null;
  }) => {
    const cls = on ? `${baseDone} ${doneClass}` : `${baseOff} ${offClass}`;
    const title = on ? label.on : label.off;
    if (on && href) {
      return (
        <Link href={href} title={title} className="inline-flex" onClick={(e) => e.stopPropagation()}>
          <IconCmp className={cls} strokeWidth={on ? 2.5 : 1.5} />
        </Link>
      );
    }
    return (
      <span title={title} className="inline-flex" aria-label={title}>
        <IconCmp className={cls} strokeWidth={on ? 2.5 : 1.5} />
      </span>
    );
  };

  return (
    <div className="flex items-center gap-1.5">
      <Icon
        on={p.has_analysis}
        doneClass="text-blue-600"
        offClass="text-text-3"
        IconCmp={BarChart3}
        label={{ on: "Analysed", off: "Not yet analysed" }}
        href={analysisHref}
      />
      <Icon
        on={p.has_tailored_cv}
        doneClass="text-purple-600"
        offClass="text-text-3"
        IconCmp={FileText}
        label={{ on: "Tailored CV ready", off: "No tailored CV yet" }}
        href={analysisHref}
      />
      <Icon
        on={p.has_cover_letter}
        doneClass="text-amber-600"
        offClass="text-text-3"
        IconCmp={Mail}
        label={{ on: "Cover letter ready", off: "No cover letter yet" }}
        href={analysisHref}
      />
      <Icon
        on={p.is_applied}
        doneClass="text-green-600"
        offClass="text-text-3"
        IconCmp={CheckCircle2}
        label={{ on: "Marked applied", off: "Not applied yet" }}
        href={null}
      />
    </div>
  );
}

// ── ⋮ overflow menu ──────────────────────────────────────────────────────────
function RowMenu({
  job, pending, onEdit, onDismiss,
}: {
  job:       Job;
  pending:   boolean;
  onEdit:    () => void;
  onDismiss: (e: React.MouseEvent) => void;
}) {
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);
  const btnRef  = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  function handleToggle(e: React.MouseEvent) {
    e.stopPropagation();
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setMenuPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
    }
    setOpen((v) => !v);
  }

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (
        menuRef.current && !menuRef.current.contains(e.target as Node) &&
        btnRef.current  && !btnRef.current .contains(e.target as Node)
      ) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const itemCls =
    "w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-text-2 hover:bg-[var(--surface-2)] hover:text-text transition-colors rounded text-left whitespace-nowrap";

  const menu = open && menuPos ? (
    <div
      ref={menuRef}
      style={{ position: "fixed", top: menuPos.top, right: menuPos.right, zIndex: 9999 }}
      className="min-w-[160px] rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-lg py-1"
      onClick={(e) => e.stopPropagation()}
    >
      <button className={itemCls} onClick={() => { setOpen(false); onEdit(); }}>
        <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536M9 13l6.586-6.586a2 2 0 112.828 2.828L11.828 15.828a2 2 0 01-1.414.586H8v-2.414a2 2 0 01.586-1.414z"/>
        </svg>
        Edit JD
      </button>

      {job.progress.latest_run_id && (
        <a
          href={`/dashboard/jobs/${job.id}/analyze/${job.progress.latest_run_id}`}
          className={itemCls}
          onClick={() => setOpen(false)}
        >
          <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/>
          </svg>
          View analysis
        </a>
      )}

      <div className="my-1 border-t border-[var(--border)]" />

      {/* "Mark as applied" intentionally removed from this menu — the
          Applications tab is the single place to mark a job applied, via
          Send email / Apply now / Mark applied on the dedicated card. */}

      <button
        disabled={pending}
        className={`${itemCls} hover:text-red-600 hover:bg-red-50`}
        onClick={(e) => { setOpen(false); onDismiss(e); }}
      >
        <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/>
        </svg>
        Dismiss
      </button>
    </div>
  ) : null;

  return (
    <>
      <button
        ref={btnRef}
        onClick={handleToggle}
        className="gh-btn p-1.5 text-text-3 hover:text-text"
        title="More actions"
      >
        <svg className="w-3.5 h-3.5" viewBox="0 0 4 16" fill="currentColor">
          <circle cx="2" cy="2"  r="1.5"/>
          <circle cx="2" cy="8"  r="1.5"/>
          <circle cx="2" cy="14" r="1.5"/>
        </svg>
      </button>
      {typeof document !== "undefined" && menu && createPortal(menu, document.body)}
    </>
  );
}

// ── Visa badge ───────────────────────────────────────────────────────────────
function VisaBadge({ sponsorship, citizenPROnly, extractedText }: {
  sponsorship:   "yes" | "no" | "not_mentioned" | null;
  citizenPROnly: boolean | null;
  extractedText: string | null;
}) {
  if (citizenPROnly === true) {
    return (
      <span className="badge badge-amber text-[10px] cursor-help" title={extractedText ?? "Citizens or permanent residents only"}>
        PR/Citizen only
      </span>
    );
  }
  if (sponsorship === "yes") {
    return (
      <span className="badge badge-green text-[10px] cursor-help" title={extractedText ?? "Visa sponsorship offered"}>
        ✓ Sponsored
      </span>
    );
  }
  if (sponsorship === "no") {
    return (
      <span className="badge badge-red text-[10px] cursor-help" title={extractedText ?? "No visa sponsorship"}>
        ✗ No sponsor
      </span>
    );
  }
  return (
    <span className="badge badge-gray text-[10px] cursor-help" title={extractedText ?? "Visa info not mentioned — check the JD manually"}>
      ? Check JD
    </span>
  );
}

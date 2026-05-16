"use client";

import { useTransition, useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { markJobApplied, markJobDismissed } from "@/lib/actions";
import { AnalyzeJobButton } from "@/components/cv/AnalyzeJobButton";
import { JobEditModal } from "@/components/cv/JobEditModal";

interface Job {
  id: string;
  profile_id: string;
  url: string;
  title: string;
  company: string;
  location: string;
  description: string;
  source: string;
  source_tier: number;
  posted_at: string | null;
  created_at: string;
  salary_min?: number;
  salary_max?: number;
  visa_likelihood: number | null;
  sponsorship_status: "yes" | "no" | "not_mentioned" | null;
  citizen_pr_only: boolean | null;
  visa_extracted_text: string | null;
  keywords_matched: string[];
  applied_at: string | null;
  dismissed_at: string | null;
  is_dead_link: boolean;
  seen_at: string | null;
  dedup_status?: string | null;
  manual_jd_text?:    string | null;
  contact_email?:     string | null;
  latest_run_id?:     string | null;
  latest_run_status?: "pending" | "running" | "completed" | "failed" | null;
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

// Used for the "Added" column. Same shape as relativeDate but compact:
//   today     → "14:32" (24-hour, local time)
//   yesterday → "Yesterday"
//   < 7 days  → "2d", "3d", …
//   < 30 days → "1w", "2w", …
//   else      → "1mo", "2mo", …
// Day comparison is calendar-based (midnight-to-midnight in local TZ) so
// a job added 1 minute past midnight reads "Yesterday" once the clock rolls.
function relativeAdded(d: string | null) {
  if (!d) return null;
  const then = new Date(d);
  const now  = new Date();
  const startOfToday = new Date(now.getFullYear(),  now.getMonth(),  now.getDate());
  const startOfThen  = new Date(then.getFullYear(), then.getMonth(), then.getDate());
  const dayDiff = Math.round((startOfToday.getTime() - startOfThen.getTime()) / 86400000);

  if (dayDiff === 0) {
    return then.toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", hour12: false });
  }
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

// Source → badge variant
function sourceBadge(source: string) {
  const map: Record<string, string> = {
    adzuna:          "badge-blue",
    greenhouse:      "badge-purple",
    lever:           "badge-purple",
    pageup:          "badge-amber",
    workday:         "badge-teal",
    smartrecruiters: "badge-green",
    ashby:           "badge-purple",
    jobadder:        "badge-amber",
    seek:            "badge-blue",
    indeed:          "badge-amber",
  };
  return map[source.toLowerCase()] ?? "badge-gray";
}

// Exit animation phases:
//   idle      → normal display
//   flash     → green background tint (applied only, 700ms)
//   fading    → opacity 0 + height collapses (400ms)
//   gone      → render null
type ExitPhase = "idle" | "flash" | "fading" | "gone";

export function JobTable({ jobs, showVisa, currentTab }: {
  jobs: Job[];
  showVisa: boolean;
  currentTab: string;
}) {
  if (jobs.length === 0) {
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

  return (
    <div className="bg-surface border border-border rounded-md overflow-hidden">
      {/* Table header */}
      <div className="grid grid-cols-12 gap-2 px-4 py-2.5 bg-[var(--surface-2)] border-b border-border text-[11px] font-semibold text-text-2 uppercase tracking-wider">
        <div className="col-span-4">Role</div>
        <div className="col-span-2">Company</div>
        <div className="col-span-1 text-center">Source</div>
        <div className="col-span-1 text-center">Posted</div>
        <div className="col-span-1 text-center">Added</div>
        {showVisa && <div className="col-span-1 text-center">Visa</div>}
        <div className={`${showVisa ? "col-span-2" : "col-span-3"} text-right`}>Actions</div>
      </div>

      {jobs.map((job, i) => (
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

function JobRow({ job, showVisa, animDelay, currentTab }: {
  job: Job;
  showVisa: boolean;
  animDelay: number;
  currentTab: string;
}) {
  const [expanded, setExpanded]     = useState(false);
  const [, startTransition]         = useTransition();
  const [isPending, setIsPending]   = useState(false);
  const [localApplied, setLocalApplied] = useState(!!job.applied_at);
  const [exitPhase, setExitPhase]   = useState<ExitPhase>("idle");
  const [showEdit, setShowEdit]     = useState(false);
  // Mirror server fields locally so the badges update without a router.refresh()
  const [manualJd, setManualJd]     = useState<string | null>(job.manual_jd_text ?? null);
  const [contactEmail, setContactEmail] = useState<string | null>(job.contact_email ?? null);

  const salary    = formatSalary(job.salary_min, job.salary_max);
  const postedAgo = relativeDate(job.posted_at || job.created_at);
  const isNew     = !job.seen_at && !localApplied && exitPhase === "idle";
  const isFlash   = exitPhase === "flash";
  const isFading  = exitPhase === "fading";

  async function handleApply(e: React.MouseEvent) {
    e.stopPropagation();
    if (localApplied || exitPhase !== "idle" || isPending) return;
    setLocalApplied(true);
    setIsPending(true);

    // Kick off exit animation immediately for snappy UX
    if (currentTab !== "applied") {
      setExitPhase("flash");
      setTimeout(() => setExitPhase("fading"), 700);
      setTimeout(() => setExitPhase("gone"), 1150);
    }

    try {
      await markJobApplied(job.id, job.profile_id);
    } catch (err) {
      console.error("[JobRow] markJobApplied failed:", err);
      // Revert local state so the row reappears
      setLocalApplied(false);
      setExitPhase("idle");
    } finally {
      setIsPending(false);
    }
  }

  async function handleDismiss(e: React.MouseEvent) {
    e.stopPropagation();
    if (exitPhase !== "idle" || isPending) return;
    setIsPending(true);
    setExitPhase("fading");
    setTimeout(() => setExitPhase("gone"), 450);
    try {
      await markJobDismissed(job.id, job.profile_id);
    } catch (err) {
      console.error("[JobRow] markJobDismissed failed:", err);
      setExitPhase("idle");
    } finally {
      setIsPending(false);
    }
  }

  if (exitPhase === "gone") return null;

  return (
    // Outer wrapper handles the height-collapse + fade animation.
    // CSS grid trick: transitioning grid-template-rows from 1fr→0fr
    // collapses height without needing a measured pixel value.
    <div
      style={{
        display: "grid",
        gridTemplateRows: isFading ? "0fr" : "1fr",
        opacity: isFading ? 0 : 1,
        transition: isFading
          ? "grid-template-rows 420ms ease, opacity 280ms ease"
          : undefined,
        overflow: "hidden",
        pointerEvents: exitPhase !== "idle" ? "none" : undefined,
      }}
    >
      {/* Inner wrapper — required for the grid trick; overflow:hidden clips collapsing content */}
      <div style={{ overflow: "hidden" }}>

        {/* ── Main row ─────────────────────────────────────────────────────── */}
        <div
          className={`grid grid-cols-12 gap-2 px-4 py-3 border-b border-border last:border-0 cursor-pointer anim-in anim-delay-${animDelay} transition-colors ${
            isFlash ? "bg-green-light" : "hover:bg-[var(--surface-2)]/60"
          } ${
            localApplied ? "border-l-2 border-l-green" : isNew ? "border-l-2 border-l-[var(--brand)]" : ""
          }`}
          onClick={() => setExpanded(!expanded)}
        >
          {/* Role */}
          <div className="col-span-4 flex items-start gap-2.5 min-w-0">
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
                {localApplied && (
                  <span className="badge badge-green text-[10px] px-1.5 h-4">Applied</span>
                )}
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
              {job.location && (
                <p className="text-[11px] text-text-3 truncate mt-0.5">{job.location}</p>
              )}
              {/* Curation indicators — match cv-magic's "JD attached"
                  pattern: small text-xs labels with semantic colour, not
                  filled badges. Uses CSS variables so each theme adapts. */}
              {(manualJd || contactEmail) && (
                <div className="flex flex-wrap items-center gap-3 mt-1 text-xs">
                  {manualJd && (
                    <span
                      className="font-semibold text-green-600"
                      title="JD has been manually trimmed for AI analysis"
                    >
                      Edited JD
                    </span>
                  )}
                  {contactEmail && (
                    <span
                      className="font-semibold text-[var(--brand)]"
                      title={contactEmail}
                    >
                      ✉ Email
                    </span>
                  )}
                </div>
              )}
              {/* Keywords */}
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

          {/* Added (fetched date) */}
          <div className="col-span-1 flex items-center justify-center">
            <span className="text-[11px] text-text-3">{relativeAdded(job.created_at) ?? "—"}</span>
          </div>

          {/* Visa status */}
          {showVisa && (
            <div className="col-span-1 flex items-center justify-center">
              <VisaBadge
                sponsorship={job.sponsorship_status}
                citizenPROnly={job.citizen_pr_only}
                extractedText={job.visa_extracted_text}
              />
            </div>
          )}

          {/* Actions — Analyze (always visible) + ⋮ overflow menu */}
          <div
            className={`${showVisa ? "col-span-2" : "col-span-3"} relative flex items-center justify-end gap-1.5`}
            onClick={(e) => e.stopPropagation()}
          >
            <AnalyzeJobButton jobId={job.id} />
            <RowMenu
              job={job}
              pending={isPending}
              localApplied={localApplied}
              onEdit={() => setShowEdit(true)}
              onApply={handleApply}
              onDismiss={handleDismiss}
            />
          </div>
        </div>

        {/* ── Expandable description ───────────────────────────────────────── */}
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
          onClose={() => setShowEdit(false)}
          onSaved={(patch) => {
            setManualJd(patch.manual_jd_text);
            setContactEmail(patch.contact_email);
          }}
        />
      )}
    </div>
  );
}

// ── ⋮ overflow menu ───────────────────────────────────────────────────────────
// Uses createPortal + position:fixed so it escapes overflow:hidden on the
// table wrapper and the row collapse animation container.

function RowMenu({
  job,
  pending,
  localApplied,
  onEdit,
  onApply,
  onDismiss,
}: {
  job: Job;
  pending: boolean;
  localApplied: boolean;
  onEdit: () => void;
  onApply: (e: React.MouseEvent) => void;
  onDismiss: (e: React.MouseEvent) => void;
}) {
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  function handleToggle(e: React.MouseEvent) {
    e.stopPropagation();
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setMenuPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
    }
    setOpen((v) => !v);
  }

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (
        menuRef.current && !menuRef.current.contains(e.target as Node) &&
        btnRef.current && !btnRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
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
      {/* Edit JD */}
      <button className={itemCls} onClick={() => { setOpen(false); onEdit(); }}>
        <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
          <path strokeLinecap="round" strokeLinejoin="round"
            d="M15.232 5.232l3.536 3.536M9 13l6.586-6.586a2 2 0 112.828 2.828L11.828 15.828a2 2 0 01-1.414.586H8v-2.414a2 2 0 01.586-1.414z"/>
        </svg>
        Edit JD
      </button>

      {/* View analysis */}
      {job.latest_run_id && (
        <a
          href={`/dashboard/jobs/${job.id}/analyze/${job.latest_run_id}`}
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

      {/* Mark applied */}
      <button
        disabled={pending || localApplied}
        className={`${itemCls} ${localApplied ? "opacity-40 cursor-default" : ""}`}
        onClick={(e) => { setOpen(false); onApply(e); }}
      >
        <svg className="w-3.5 h-3.5 shrink-0 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"/>
        </svg>
        <span className={localApplied ? "text-green-600 font-medium" : ""}>
          {localApplied ? "Applied ✓" : "Mark as applied"}
        </span>
      </button>

      {/* Dismiss */}
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
        {/* Vertical ellipsis (⋮) */}
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

// ── Visa status badge ─────────────────────────────────────────────────────────

function VisaBadge({
  sponsorship,
  citizenPROnly,
  extractedText,
}: {
  sponsorship: "yes" | "no" | "not_mentioned" | null;
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

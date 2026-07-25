"use client";

import { createContext, useContext, useState } from "react";
import {
  BarChart3, FileText, Mail, CheckCircle2, Inbox, Star, Loader2 } from "lucide-react";
import { markJobApplied, markJobDismissed, toggleStarJob } from "@/lib/actions/jobs";
import { AnalyzeJobButton, FullAnalysisButton } from "@/features/cv/analysis/AnalyzeJobButton";
import { JobEditModal } from "./JobEditModal";
import { jobNeedsJd, MANUAL_JD_MIN_CHARS, type BoardJob } from "../lib/jobFilters";
import { useJobSelection } from "./feedSelection";
import {
  relativeDate, getAtsMeta, visaKey, VISA_COLOR, VISA_LABEL,
  EMPLOYMENT_CHIP_LABEL, daysUntilClose, formatSalary,
} from "@/features/jobs/lib/smartFeedUtils";
import { Badge } from "@/components/ui";
import { CardMenu } from "./CardMenu";
import { PIPELINE_STATE_META } from "@/features/jobs/lib/pipelineState";

// ── smart-section bucketing ─────────────────────────────────────────────

export function HeroCard({ job, currentTab, refSetter, excludeKeywords }: { job: BoardJob; currentTab: string; refSetter: (el: HTMLDivElement | null) => void; excludeKeywords?: string }) {
  return (
    <CardShell job={job} currentTab={currentTab} refSetter={refSetter} hero excludeKeywords={excludeKeywords}>
      <CardChips job={job} />
      <CardTitle job={job} />
      <CardMeta job={job} />
      <div className="mt-2"><MatchBar job={job} /></div>
      <CardActions job={job} />
    </CardShell>
  );
}

// ── compact card ────────────────────────────────────────────────────────

export function JobCard({ job, currentTab, refSetter, excludeKeywords }: { job: BoardJob; currentTab: string; refSetter: (el: HTMLDivElement | null) => void; excludeKeywords?: string }) {
  return (
    <CardShell job={job} currentTab={currentTab} refSetter={refSetter} excludeKeywords={excludeKeywords}>
      <div className="flex flex-col" style={{ gap: 9 }}>
        <div className="flex items-start gap-2.5">
          <CardTitle job={job} />
          <CardActionsContext.Consumer>
            {({ onToggleStar, starred }) => (
              <button
                type="button"
                onClick={onToggleStar}
                title={starred ? "Remove from favourites" : "Add to favourites"}
                className="shrink-0 hover:opacity-80 transition-opacity mt-0.5"
                style={{ background: "none", border: "none", cursor: "pointer", color: starred ? "#d97706" : "#d1d5db", fontSize: 17, lineHeight: 1, padding: 0 }}
              >
                <Star
                  style={{ width: 17, height: 17 }}
                  fill={starred ? "currentColor" : "none"}
                  strokeWidth={starred ? 0 : 1.5}
                />
              </button>
            )}
          </CardActionsContext.Consumer>
        </div>
        <CardMeta job={job} compact />
        <SalaryLine job={job} />
        <CardFooter job={job} />
      </div>
    </CardShell>
  );
}

function CardFooter({ job }: { job: BoardJob }) {
  const ctx = useContext(CardActionsContext);
  const state = job.pipelineState ?? "discovered";
  const meta = PIPELINE_STATE_META[state];
  const score = job.tailored_match_score ?? job.initial_ats_score;
  const bothScores = job.initial_ats_score != null && job.tailored_match_score != null && job.initial_ats_score !== job.tailored_match_score;
  const [applying, setApplying] = useState(false);

  const toneColors: Record<string, string> = {
    success: "bg-green-light text-green-700 border-green-500/30",
    warning: "bg-amber-light text-amber-700 border-amber-500/30",
    danger:  "bg-red-light text-red-700 border-red-500/30",
    neutral: "bg-[var(--surface-2)] text-text-2 border-border",
  };
  const dotColors: Record<string, string> = {
    success: "bg-green-500",
    warning: "bg-amber-500",
    danger:  "bg-red-500",
    neutral: "bg-gray-400",
  };

  let chipDisplay: string;
  if (state === "applied" || state === "ready_to_apply" || state === "ready_to_send") {
    chipDisplay = score != null ? `${score} · ${meta.label}` : meta.label;
  } else if ((state === "below_final" || state === "below_initial") && bothScores) {
    chipDisplay = `${job.initial_ats_score} → ${job.tailored_match_score}`;
  } else if (score != null) {
    chipDisplay = `${score}`;
  } else if (state === "discovered" && job.progress.has_analysis) {
    chipDisplay = "Analysed";
  } else {
    chipDisplay = meta.label;
  }

  async function onApply(e: React.MouseEvent) {
    e.stopPropagation();
    if (applying) return;
    setApplying(true);
    try {
      window.open(job.url, "_blank", "noopener,noreferrer");
      await markJobApplied(job.id, job.profile_id);
    } finally {
      setApplying(false);
    }
  }

  async function onAnalyse(e: React.MouseEvent) {
    e.stopPropagation();
    if (ctx.pending) return;
    const url = `/api/jobs/${job.id}/analyze`;
    try {
      await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    } catch {}
  }

  let actionButton: React.ReactNode = null;
  if (state === "applied") {
    actionButton = <span className="badge badge-green text-micro font-semibold">✓ Applied</span>;
  } else if (state === "ready_to_apply" || state === "ready_to_send") {
    actionButton = (
      <button type="button" onClick={onApply} disabled={applying}
        className="text-[12.5px] font-semibold px-[13px] py-[6px] rounded-[8px] bg-[var(--brand)] text-white hover:opacity-90 transition-opacity disabled:opacity-50"
      >
        {applying ? <Loader2 className="w-3 h-3 animate-spin" /> : "Apply"}
      </button>
    );
  } else if (state === "needs_jd") {
    actionButton = (
      <button type="button" onClick={(e) => { e.stopPropagation(); ctx.onEdit(); }}
        className="text-[12.5px] font-semibold px-[13px] py-[6px] rounded-[8px] border border-[var(--brand)]/30 text-[var(--brand)] bg-transparent hover:bg-[var(--brand)]/5 transition-colors"
      >
        Add JD
      </button>
    );
  } else if (state === "discovered" && !job.progress.has_analysis) {
    actionButton = (
      <button type="button" onClick={onAnalyse}
        className="text-[12.5px] font-semibold px-[13px] py-[6px] rounded-[8px] bg-[var(--brand)] text-white hover:opacity-90 transition-opacity"
      >
        Analyse
      </button>
    );
  } else if (job.progress.latest_run_status === "failed") {
    actionButton = (
      <button type="button" onClick={onAnalyse}
        className="text-[12.5px] font-semibold px-[13px] py-[6px] rounded-[8px] border border-[var(--brand)]/30 text-[var(--brand)] bg-transparent hover:bg-[var(--brand)]/5 transition-colors"
      >
        Retry
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2 mt-0.5 flex-wrap" onClick={(e) => e.stopPropagation()}>
      <SourcePill source={job.source} />
      <span className={`inline-flex items-center gap-[5px] text-[12px] font-semibold px-[10px] py-[3px] rounded-full border ${toneColors[meta.tone] ?? toneColors.neutral}`}>
        <span className={`inline-block w-[6px] h-[6px] rounded-full ${dotColors[meta.tone] ?? dotColors.neutral}`} />
        {chipDisplay}
      </span>
      <div className="flex-1" />
      {actionButton}
    </div>
  );
}

function SalaryLine({ job }: { job: BoardJob }) {
  const salary = formatSalary(job);
  const types = (job.employment_types ?? []).map((t) => EMPLOYMENT_CHIP_LABEL[t] ?? t);
  if (!salary && types.length === 0) return null;
  const parts = [salary, ...types].filter(Boolean);
  if (parts.length === 0) return null;
  return <p className="text-[13px] text-text-2">{parts.join(" · ")}</p>;
}

// ── card shell ──────────────────────────────────────────────────────────

type ExitPhase = "idle" | "flash" | "fading" | "gone";

export function CardShell({
  job, refSetter, hero, children, excludeKeywords }: {
  job: BoardJob;
  currentTab: string;
  refSetter: (el: HTMLDivElement | null) => void;
  hero?: boolean;
  children: React.ReactNode;
  excludeKeywords?: string;
}) {
  const [exit, setExit] = useState<ExitPhase>("idle");
  const [showEdit, setShowEdit] = useState(false);
  const [manualJd, setManualJd] = useState<string | null>(job.manual_jd_text ?? null);
  const [savedFlicker, setSavedFlicker] = useState(false);
  const [contactEmail, setContactEmail] = useState<string | null>(job.contact_email ?? null);
  const [hiringMgr, setHiringMgr] = useState<string | null>(job.hiring_manager ?? null);
  const [companyAddress, setCompanyAddress] = useState<string | null>(job.company_address ?? null);
  const [pending, setPending] = useState(false);
  const [starred, setStarred] = useState<boolean>(!!job.starred_at);
  const [starPending, setStarPending] = useState(false);

  async function onToggleStar(e: React.MouseEvent) {
    e.stopPropagation();
    if (starPending) return;
    setStarPending(true);
    setStarred((v) => !v);
    try { await toggleStarJob(job.id); }
    catch { setStarred((v) => !v); }
    finally { setStarPending(false); }
  }

  const selection  = useJobSelection();
  const selectable = selection?.selectMode ?? false;
  const checked    = selection?.isSelected(job.id) ?? false;
  const isActive   = selection?.activeJobId === job.id;

  // Master-detail: clicking the card body opens this job in the detail pane
  // (or, in bulk-select mode, toggles selection instead — selection intent
  // wins there rather than also opening detail).
  function onCardClick() {
    if (selectable) { selection?.toggle(job.id); return; }
    selection?.onOpenDetail?.(job.id);
  }

  async function onDismiss() {
    if (exit !== "idle" || pending) return;
    setPending(true);
    setExit("fading");
    setTimeout(() => setExit("gone"), 450);
    try { await markJobDismissed(job.id, job.profile_id); }
    catch { setExit("idle"); }
    finally { setPending(false); }
  }

  if (exit === "gone") return null;

  const isFading = exit === "fading";
  const isFlash  = exit === "flash";

  return (
    <div
      style={{
        display: "grid",
        gridTemplateRows: isFading ? "0fr" : "1fr",
        opacity: isFading ? 0 : 1,
        transition: isFading ? "grid-template-rows 420ms ease, opacity 280ms ease" : undefined,
        overflow: "hidden",
        pointerEvents: exit !== "idle" ? "none" : undefined }}
    >
      <div style={{ overflow: "hidden" }} className="relative">
        {selectable && (
          <button
            type="button"
            onClick={() => selection!.toggle(job.id)}
            className={`absolute top-3 left-2.5 z-10 w-5 h-5 rounded border flex items-center justify-center transition-colors ${
              checked
                ? "bg-[var(--brand)] border-[var(--brand)]"
                : "bg-[var(--surface)] border-[var(--border)] hover:border-[var(--brand)]"
            }`}
            aria-label={checked ? "Deselect job" : "Select job"}
          >
            {checked && <CheckCircle2 className="w-3.5 h-3.5 text-white" strokeWidth={3} />}
          </button>
        )}
        <div
          ref={refSetter}
          onClick={onCardClick}
          className={`transition-all cursor-pointer bg-surface rounded-xl px-[18px] py-4 hover:shadow-[0_2px_10px_rgba(16,24,40,0.07)] ${
            hero ? "border-2 border-[var(--brand)]/30 p-4" : ""
          } ${selectable ? "pl-10" : ""} ${
            isFlash ? "bg-green-light" : ""
          } ${savedFlicker ? "jd-saved-flicker" : ""}`}
          style={hero ? undefined : (() => {
            // Never mix a `borderLeft` shorthand with `borderWidth/Style/Color`
            // in one style object — React's style diffing drops the left-side
            // longhands on client re-render (cards lose their left border until
            // a full reload). Use 4-value shorthands for the applied accent.
            const tone = isFlash ? "#22c55e" : checked || isActive ? "#2563eb" : "var(--border)";
            const applied = !!job.applied_at;
            return {
              borderWidth: applied ? "1px 1px 1px 2px" : "1px",
              borderStyle: "solid",
              borderColor: applied ? `${tone} ${tone} ${tone} #22c55e` : tone,
              boxShadow: checked || isActive ? "0 0 0 3px rgba(37,99,235,0.12)" : undefined,
            };
          })()}
        >
          <CardActionsContext.Provider value={{ onDismiss, onEdit: () => setShowEdit(true), onToggleStar, starred, pending }}>
            {children}
          </CardActionsContext.Provider>
        </div>
      </div>

      {showEdit && (
        <JobEditModal
          jobId={job.id}
          jobUrl={job.url}
          originalJd={job.description ?? ""}
          initialManual={manualJd}
          initialEmail={contactEmail}
          initialHiringMgr={hiringMgr}
          initialCompanyAddress={companyAddress}
          excludeKeywords={excludeKeywords}
          onClose={() => setShowEdit(false)}
          onSaved={(patch) => {
            const wasThin = job.jd_quality === "thin" || job.jd_quality === "unknown";
            const nowFilled = (patch.manual_jd_text?.trim().length ?? 0) >= MANUAL_JD_MIN_CHARS;
            if (wasThin && nowFilled) {
              setSavedFlicker(true);
              setTimeout(() => setSavedFlicker(false), 1900);
            }
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

const CardActionsContext = createContext<{
  onDismiss:    () => Promise<void>;
  onEdit:       () => void;
  onToggleStar: (e: React.MouseEvent) => void;
  starred:      boolean;
  pending:      boolean;
}>({ onDismiss: async () => {}, onEdit: () => {}, onToggleStar: () => {}, starred: false, pending: false });

// ── card sub-pieces ─────────────────────────────────────────────────────

// Work-rights requirement stated in the JD → chip label. Only genuinely
// stated requirements render (not_stated / unknown values show nothing).
const WORK_RIGHTS_CHIP_LABEL: Record<string, string> = {
  citizen_only:      "Citizens only",
  pr_citizen:        "PR / Citizen",
  full_unrestricted: "Full work rights",
  any_valid:         "Any work visa" };

export function FactsChips({ job }: { job: BoardJob }) {
  const applyEmail = job.extracted_emails?.find((e) => e.kind === "application");
  const anyEmail = applyEmail ?? job.extracted_emails?.[0];
  const closeDays = daysUntilClose(job);
  const workRights = job.work_rights_requirement
    ? WORK_RIGHTS_CHIP_LABEL[job.work_rights_requirement]
    : undefined;
  return (
    <>
      {(job.employment_types ?? []).map((t) => (
        <Badge key={t} variant="blue" className="text-micro px-1.5 h-4" title="Work type (from the JD/source)">
          {EMPLOYMENT_CHIP_LABEL[t] ?? t}
        </Badge>
      ))}
      {workRights && (
        <span
          className="badge badge-purple text-micro px-1.5 h-4"
          title={job.visa_extracted_text ?? "Work-rights requirement stated in the JD"}
        >
          {workRights}
        </span>
      )}
      {job.sponsorship_status === "yes" && (
        <span className="badge badge-green text-micro px-1.5 h-4" title={job.visa_extracted_text ?? "The JD states visa sponsorship is available"}>
          Sponsorship
        </span>
      )}
      {anyEmail && (
        <Badge
          variant="gray"
          className="text-micro px-1.5 h-4 cursor-copy"
          title={`${anyEmail.kind === "application" ? "Apply by email" : "Contact"}: ${anyEmail.email}${anyEmail.person ? ` (${anyEmail.person})` : ""} — click card menu to copy`}
        >
          ✉ {anyEmail.kind === "application" ? "Apply by email" : "Contact"}
        </Badge>
      )}
      {closeDays !== null && closeDays <= 14 && (
        <Badge
          variant={closeDays <= 3 ? "red" : "amber"}
          className="text-micro px-1.5 h-4"
          title={`Applications close ${job.closing_date}`}
        >
          Closes {closeDays === 0 ? "today" : `in ${closeDays}d`}
        </Badge>
      )}
      {job.is_agency === true && (
        <Badge variant="gray" className="text-micro px-1.5 h-4" title="Posted by a recruitment agency">
          Agency
        </Badge>
      )}
      {job.eligibility === "not_eligible" && (
        <Badge variant="red" className="text-micro px-1.5 h-4" title={job.visa_extracted_text ?? "Based on the JD's stated work-rights requirement vs your visa status (Profile)"}>
          Not eligible
        </Badge>
      )}
      {job.hours_cap_conflict && job.eligibility !== "not_eligible" && (
        <Badge variant="amber" className="text-micro px-1.5 h-4" title="Full-time only — may conflict with student-visa hour caps">
          FT only ⚠
        </Badge>
      )}
    </>
  );
}

export function CardChips({ job }: { job: BoardJob }) {
  return (
    <div className="flex items-center gap-2 mb-2 flex-wrap">
      <span
        className={`inline-block w-2.5 h-2.5 rounded-full ${getAtsMeta(job).dot}`}
        title={`ATS ${getAtsMeta(job).label} — ${getAtsMeta(job).tip}`}
      />
      <SourcePill source={job.source} />
      {job.profile_name && <ProfileChip name={job.profile_name} />}
      {job.atsBand !== "no_ats" && <AtsChip job={job} />}
      <FactsChips job={job} />
      <span
        className="inline-block w-2 h-2 rounded-full ml-auto"
        style={{ background: VISA_COLOR[visaKey(job)] }}
        title={VISA_LABEL[visaKey(job)]}
      />
      <span className="text-micro text-text-3">{relativeDate(job.posted_at || job.created_at) ?? "—"}</span>
    </div>
  );
}

export function CardTitle({ job, inline }: { job: BoardJob; inline?: boolean }) {
  return (
    <a
      href={job.url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className={`font-semibold text-text hover:text-[var(--brand)] leading-snug ${inline ? "break-words" : "block"} ${!inline ? "flex-1 min-w-0" : ""}`}
      style={!inline ? { fontSize: 15, lineHeight: 1.4 } : undefined}
    >
      {job.title}
    </a>
  );
}

export function CardMeta({ job, compact }: { job: BoardJob; compact?: boolean }) {
  const postedRel = relativeDate(job.posted_at);
  const addedRel  = relativeDate(job.created_at);
  return (
    <p className={`${compact ? "mt-1 text-label" : "text-caption"} text-text-2`}>
      {job.company && <span className="font-medium">{job.company}</span>}
      {job.company && job.location && <span className="text-text-3"> · </span>}
      {job.location && <span>{job.location}</span>}
      {typeof job.distance_km === "number" && (
        <>
          <span className="text-text-3"> · </span>
          <Distance km={job.distance_km} method={job.distance_method ?? null} />
        </>
      )}
      {postedRel && (
        <>
          <span className="text-text-3"> · </span>
          <span title={`Posted ${new Date(job.posted_at as string).toLocaleDateString("en-AU", {day: "2-digit", month: "2-digit", year: "numeric"})}`}>
            Posted {postedRel.toLowerCase()}
          </span>
        </>
      )}
      {!postedRel && addedRel && (
        <>
          <span className="text-text-3"> · </span>
          <span title={`Added ${new Date(job.created_at as string).toLocaleDateString("en-AU", {day: "2-digit", month: "2-digit", year: "numeric"})}`}>
            Added {addedRel.toLowerCase()}
          </span>
        </>
      )}
    </p>
  );
}

export function CardActions({ job, compact }: { job: BoardJob; compact?: boolean }) {
  const { onDismiss, onEdit, onToggleStar, starred, pending } = useContext(CardActionsContext);
  return (
    <div
      className={`flex items-center gap-2 shrink-0 ${compact ? "" : "mt-2 justify-between"}`}
      onClick={(e) => e.stopPropagation()}
    >
      {!compact && <ProgressDots progress={job.progress} />}
      <div className="flex items-center gap-1.5">
        {compact && <ProgressDots progress={job.progress} />}
        <button
          type="button"
          onClick={onToggleStar}
          title={starred ? "Remove from favourites" : "Add to favourites"}
          className="p-1 rounded hover:bg-[var(--surface-2)] transition-colors"
        >
          <Star
            className={`w-3.5 h-3.5 transition-colors ${starred ? "text-amber-400 fill-amber-400" : "text-text-3"}`}
            strokeWidth={starred ? 0 : 1.5}
          />
        </button>
        {job.progress.latest_run_id ? (
          <FullAnalysisButton
            jobId={job.id}
            analysisHref={`/jobs/${job.id}/analyze/${job.progress.latest_run_id}`}
          />
        ) : job.applied_at ? (
          <button
            disabled
            className="flex items-center gap-1.5 rounded-md bg-[var(--surface-2)] border border-border px-2.5 py-1 text-xs font-medium text-text-3 cursor-not-allowed"
            title="This job was manually marked as applied and has no analysis run."
          >
            No Analysis
          </button>
        ) : (
          <AnalyzeJobButton jobId={job.id} hasAnalysis={job.progress.has_analysis} />
        )}
        <CardMenu
          job={job}
          onDismiss={onDismiss}
          onEdit={onEdit}
          pending={pending}
        />
      </div>
    </div>
  );
}

// ── tiny presentational primitives ──────────────────────────────────────

export function MatchBar({ job, compact }: { job: BoardJob; compact?: boolean }) {
  const atsScore = job.tailored_match_score ?? job.initial_ats_score ?? null;
  if (atsScore == null) return null;

  const displayScore = atsScore;
  const cls          = getAtsMeta(job).barColor;
  const tip          = `ATS score ${displayScore}/100 — ${getAtsMeta(job).tip}`;

  return (
    <div className="flex items-center gap-1.5" title={tip}>
      {!compact && (
        <span className="text-micro font-semibold text-text-3 shrink-0 uppercase tracking-wide w-7 text-right">
          ATS
        </span>
      )}
      <div className={`relative bg-[var(--surface-2)] rounded-full overflow-hidden ${compact ? "h-1" : "h-1.5"} flex-1`}>
        <div className={`h-full ${cls}`} style={{ width: `${displayScore}%` }} />
      </div>
      <span className={`tabular-nums font-semibold text-text-2 shrink-0 ${compact ? "text-micro" : "text-caption"}`}>
        {displayScore}
      </span>
    </div>
  );
}

export function ProgressDots({ progress }: { progress: BoardJob["progress"] }) {
  const items = [
    { on: progress.has_analysis,      Icon: BarChart3,    cls: "text-blue-600",   label: "Analysed" },
    { on: progress.has_tailored_cv,   Icon: FileText,     cls: "text-purple-600", label: "Tailored CV" },
    { on: progress.has_cover_letter,  Icon: Mail,         cls: "text-amber-600",  label: "Cover letter" },
    { on: progress.is_applied,        Icon: CheckCircle2, cls: "text-green-600",  label: "Applied" },
  ];
  return (
    <div className="flex items-center gap-1">
      {items.map(({ on, Icon, cls, label }, i) => (
        <Icon
          key={i}
          className={`w-3.5 h-3.5 ${on ? cls : "text-text-3 opacity-30"}`}
          strokeWidth={on ? 2.5 : 1.5}
          aria-label={label}
        />
      ))}
    </div>
  );
}

export function ProfileChip({ name }: { name: string }) {
  return (
    <span
      className="text-micro font-medium px-1.5 py-px rounded shrink-0 bg-[var(--surface-2)] text-text-2 border border-border"
      title={`Found via the "${name}" search profile`}
    >
      {name}
    </span>
  );
}

export function SourcePill({ source }: { source: string }) {
  return (
    <span
      className="shrink-0 rounded-[5px] px-[7px] py-[3px] bg-[#f0f1f4] text-text-2"
      style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".03em" }}
      title={`Source: ${source}`}
    >
      {source}
    </span>
  );
}

export function AtsChip({ job }: { job: BoardJob }) {
  const meta = getAtsMeta(job);
  return (
    <span
      title={meta.tip}
      className={`text-micro font-semibold px-1.5 py-px rounded shrink-0 ${meta.chipBg} ${meta.chipText}`}
    >
      ATS {meta.label}
    </span>
  );
}

export function ChipWarn({ label, tooltip }: { label: string; tooltip: string }) {
  return (
    <span
      title={tooltip}
      className="text-micro font-medium px-1.5 py-px rounded shrink-0 bg-amber-100 text-amber-800"
    >
      {label}
    </span>
  );
}

export function Distance({ km, method }: { km: number; method: "driving" | "haversine" | null }) {
  const approx = method === "haversine";
  const tone = km <= 10 ? "text-green-600" : km <= 25 ? "text-text-2" : km <= 50 ? "text-amber-600" : "text-red-600";
  const display = km < 10 ? km.toFixed(1) : Math.round(km);
  return (
    <span
      className={`tabular-nums font-medium ${tone}`}
      title={approx ? "Straight-line estimate" : "Driving distance from your home address"}
    >
      {approx ? "~" : ""}{display} km
    </span>
  );
}

export function EmptyState({ favourite = false }: { favourite?: boolean }) {
  return (
    <div className="bg-surface border border-border rounded-md">
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <div className="w-12 h-12 rounded-lg bg-[var(--surface-2)] border border-border flex items-center justify-center mb-4">
          {favourite
            ? <Star className="w-5 h-5 text-text-3" />
            : <Inbox className="w-5 h-5 text-text-3" />}
        </div>
        {favourite ? (
          <>
            <p className="text-title font-semibold text-text mb-1">No favourite jobs</p>
            <p className="text-label text-text-2">Star a job to shortlist it here.</p>
          </>
        ) : (
          <>
            <p className="text-title font-semibold text-text mb-1">No jobs match your filters</p>
            <p className="text-label text-text-2">Adjust the filters above or run the pipeline to fetch new listings.</p>
          </>
        )}
      </div>
    </div>
  );
}

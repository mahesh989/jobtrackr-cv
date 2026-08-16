"use client";

/**
 * Small chips, pills and badges rendered on a job card.
 *
 * Split out of the former single-file FeedCards.tsx (839 lines). Pure code
 * motion — component bodies and ordering are unchanged. Every component is
 * still importable from "./FeedCards".
 * 
 */
import { BarChart3, CheckCircle2, FileText, Mail } from "lucide-react";
import { BoardJob } from "../../lib/jobFilters";
import { EMPLOYMENT_CHIP_LABEL, VISA_COLOR, VISA_LABEL, daysUntilClose, getAtsMeta, relativeDate, visaKey } from "@/features/jobs/lib/smartFeedUtils";
import { Badge } from "@/components/ui";
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
      <SourcePill source={job.source} />
      {job.profile_name && <ProfileChip name={job.profile_name} />}
      <FactsChips job={job} />
      <SponsorshipBadge job={job} />
      <span className="text-micro text-text-3">{relativeDate(job.posted_at || job.created_at) ?? "—"}</span>
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
    { on: progress.has_analysis,      Icon: BarChart3,    cls: "text-info",   label: "Analysed" },
    { on: progress.has_tailored_cv,   Icon: FileText,     cls: "text-accent", label: "Tailored CV" },
    { on: progress.has_cover_letter,  Icon: Mail,         cls: "text-warning",  label: "Cover letter" },
    { on: progress.is_applied,        Icon: CheckCircle2, cls: "text-success",  label: "Applied" },
  ];
  return (
    <div className="flex items-center gap-1">
      {items.map(({ on, Icon, cls, label }, i) => (
        <Icon
          key={i}
          className={`w-[15px] h-[15px] ${on ? cls : "text-text-3 opacity-30"}`}
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

const SOURCE_DOT: Record<string, string> = {
  adzuna: "var(--brand)", seek: "var(--brand)", careerjet: "var(--teal)",
  greenhouse: "var(--purple)", lever: "var(--purple)", indeed: "var(--amber)",
};

export function SourcePill({ source }: { source: string }) {
  return (
    <span
      // Demo `.source-pill`: neutral pill (surface-2 + border, 999px) with a
      // source-coloured dot — 12px/500, padding 2px 9px, gap 5px, dot 8px.
      className="inline-flex items-center gap-[5px] shrink-0 rounded-full border border-border bg-[var(--surface-2)] px-[9px] py-0.5 text-[12px] font-medium text-text-2"
      title={`Source: ${source}`}
    >
      <span
        className="w-2 h-2 rounded-full shrink-0"
        style={{ background: SOURCE_DOT[source.toLowerCase()] ?? "#94a3b8" }}
      />
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
      className="text-micro font-medium px-1.5 py-px rounded shrink-0 bg-warning-subtle text-warning"
    >
      {label}
    </span>
  );
}

export function Distance({ km, method }: { km: number; method: "driving" | "haversine" | null }) {
  const approx = method === "haversine";
  const tone = km <= 10 ? "text-success" : km <= 25 ? "text-text-2" : km <= 50 ? "text-warning" : "text-danger";
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

export function SponsorshipBadge({ job }: { job: BoardJob }) {
  const key = visaKey(job);
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-border px-1.5 py-0.5 text-micro font-medium text-text-2"
      title={VISA_LABEL[key]}
    >
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: VISA_COLOR[key] }} />
      {VISA_LABEL[key]}
    </span>
  );
}

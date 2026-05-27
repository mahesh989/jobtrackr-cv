"use client";

/**
 * Beta preview of the redesigned per-profile job board.
 *
 * Reuses realistic mock data so the page is self-contained — no DB hit,
 * nothing to mutate, safe in production.
 *
 * Redesign goals (vs JobTable.tsx):
 *   1. Drop the "Added" column; fold into a tooltip on "Posted".
 *   2. Drop the "Source" column; inline as a small pill next to title.
 *   3. Drop the avatar circle; the company name is right there in the meta row.
 *   4. Visa becomes a 10px coloured dot with the verdict in a tooltip.
 *   5. Matched-keyword chips render only when they *differ* from the search
 *      keywords (i.e. an interesting match), not on every single row.
 *   6. Two main columns: Job (title + chip row + meta) and Actions.
 *   7. Density toggle (Comfy / Compact) at top — Compact pins everything
 *      to a single line per job.
 */

import { useMemo, useState } from "react";
import { BarChart3, FileText, Mail, CheckCircle2, MoreHorizontal } from "lucide-react";

// ── mock data ───────────────────────────────────────────────────────────

type VisaStatus = "yes" | "no" | "pr_only" | "unknown";
type JdQuality = "rich" | "thin" | "unknown";

interface MockJob {
  id: string;
  title: string;
  company: string;
  location: string;            // canonicalised — single suburb
  distance_km: number | null;
  source: "adzuna" | "seek" | "careerjet" | "greenhouse" | "lever";
  posted_label: string;        // e.g. "6d ago"
  added_iso: string;           // for the tooltip
  visa: VisaStatus;
  jd_quality: JdQuality;
  possible_duplicate?: boolean;
  is_new?: boolean;
  /** Only set when the match is *unusual* — e.g. matched an uncommon keyword */
  unusual_keyword?: string | null;
  progress: { analysed: boolean; tailored: boolean; cover: boolean; applied: boolean };
}

const SEARCH_KEYWORDS = ["Enrolled Nurse", "EN"];

const JOBS: MockJob[] = [
  {
    id: "1",
    title: "Enrolled Nurse — Killara Glades Care Community",
    company: "Opal HealthCare",
    location: "Killara, Ku-ring-gai",
    distance_km: 30,
    source: "adzuna",
    posted_label: "6d ago",
    added_iso: "2026-05-21T20:38:00",
    visa: "unknown",
    jd_quality: "thin",
    possible_duplicate: true,
    is_new: true,
    progress: { analysed: false, tailored: false, cover: false, applied: false },
  },
  {
    id: "2",
    title: "Enrolled Nurse (EN) — LGBTQIA Community Supports — Sydney CBD",
    company: "Chosen Family",
    location: "The Rocks, Sydney",
    distance_km: 22,
    source: "adzuna",
    posted_label: "1w ago",
    added_iso: "2026-05-20T20:38:00",
    visa: "unknown",
    jd_quality: "thin",
    progress: { analysed: false, tailored: false, cover: false, applied: false },
  },
  {
    id: "3",
    title: "Enrolled Nurse | Myhealth Northmead",
    company: "Myhealth Medical Centres",
    location: "Northmead, Parramatta",
    distance_km: 28,
    source: "adzuna",
    posted_label: "1w ago",
    added_iso: "2026-05-20T20:38:00",
    visa: "unknown",
    jd_quality: "thin",
    progress: { analysed: false, tailored: false, cover: false, applied: false },
  },
  {
    id: "4",
    title: "Endorsed Enrolled Nurse — Mental Health",
    company: "Healthscope",
    location: "Bronte, Eastern Suburbs",
    distance_km: 22,
    source: "adzuna",
    posted_label: "1w ago",
    added_iso: "2026-05-20T20:38:00",
    visa: "unknown",
    jd_quality: "thin",
    unusual_keyword: "Endorsed",
    progress: { analysed: false, tailored: false, cover: false, applied: false },
  },
  {
    id: "5",
    title: "Enrolled Nurse — Anaesthetics and PACU",
    company: "Nexus",
    location: "Kogarah, Rockdale",
    distance_km: 3.3,
    source: "adzuna",
    posted_label: "2w ago",
    added_iso: "2026-05-13T20:38:00",
    visa: "unknown",
    jd_quality: "thin",
    progress: { analysed: false, tailored: false, cover: false, applied: false },
  },
  {
    id: "6",
    title: "Enrolled Endorsed Nurse",
    company: "St Vincent's Health Australia",
    location: "North Sydney",
    distance_km: 24,
    source: "careerjet",
    posted_label: "Today",
    added_iso: "2026-05-27T20:38:00",
    visa: "no",
    jd_quality: "rich",
    is_new: true,
    progress: { analysed: false, tailored: false, cover: false, applied: false },
  },
  {
    id: "7",
    title: "Enrolled Nurse — Permanent Full-time position — Forbes",
    company: "Catholic Healthcare",
    location: "Sydney",
    distance_km: 21,
    source: "careerjet",
    posted_label: "Today",
    added_iso: "2026-05-27T20:38:00",
    visa: "yes",
    jd_quality: "rich",
    is_new: true,
    progress: { analysed: true, tailored: true, cover: false, applied: false },
  },
  {
    id: "8",
    title: "Enrolled Nurse, Community Health",
    company: "NSW Health",
    location: "Randwick",
    distance_km: 19,
    source: "careerjet",
    posted_label: "Today",
    added_iso: "2026-05-27T20:38:00",
    visa: "pr_only",
    jd_quality: "rich",
    is_new: true,
    progress: { analysed: false, tailored: false, cover: false, applied: false },
  },
  {
    id: "9",
    title: "Enrolled Nurse — Orthopaedics & ENT — Perm/Temp F/PT",
    company: "NSW Health",
    location: "Caringbah, Sutherland",
    distance_km: 9.6,
    source: "careerjet",
    posted_label: "Today",
    added_iso: "2026-05-27T20:38:00",
    visa: "pr_only",
    jd_quality: "rich",
    progress: { analysed: false, tailored: false, cover: false, applied: false },
  },
  {
    id: "10",
    title: "Enrolled Nurse Transition Program — St Vincent's Public Hospital",
    company: "NSW Health",
    location: "Sydney",
    distance_km: 21,
    source: "careerjet",
    posted_label: "Today",
    added_iso: "2026-05-27T20:38:00",
    visa: "no",
    jd_quality: "rich",
    progress: { analysed: true, tailored: true, cover: true, applied: true },
  },
];

// ── component ───────────────────────────────────────────────────────────

export function JobBoardBetaClient() {
  const [density, setDensity] = useState<"comfy" | "compact">("comfy");
  const [groupByCompany, setGroupByCompany] = useState(false);

  const grouped = useMemo(() => {
    if (!groupByCompany) return [{ company: null as string | null, jobs: JOBS }];
    const map = new Map<string, MockJob[]>();
    for (const j of JOBS) {
      const arr = map.get(j.company) ?? [];
      arr.push(j);
      map.set(j.company, arr);
    }
    return Array.from(map.entries()).map(([company, jobs]) => ({ company, jobs }));
  }, [groupByCompany]);

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">

      {/* Beta banner */}
      <div className="mb-5 flex items-start gap-3 p-3 rounded-md border border-[var(--brand)]/30 bg-[#DDF4FF] text-[12px] text-text">
        <span className="inline-flex items-center justify-center w-5 h-5 rounded bg-[var(--brand)] text-white text-[10px] font-bold shrink-0">β</span>
        <div className="min-w-0">
          <p className="font-semibold">Job board redesign — preview only</p>
          <p className="text-text-2 mt-0.5 leading-relaxed">
            Pure UI mock with sample data. Buttons don&apos;t do anything. Compared to the current table:
            no avatar circle, no Source column, no Added column, visa as a coloured dot,
            and keyword chips appear only when an <em>unusual</em> keyword matches (not on every row).
          </p>
        </div>
      </div>

      {/* Toolbar */}
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="text-[13px] text-text-2">
          <strong className="text-text">{JOBS.length}</strong> jobs · distances from <em>40-42 Empress Street, Hurstville NSW</em>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-[11px] text-text-2 cursor-pointer">
            <input
              type="checkbox"
              checked={groupByCompany}
              onChange={(e) => setGroupByCompany(e.target.checked)}
              className="w-3.5 h-3.5 accent-[var(--brand)] cursor-pointer"
            />
            Group by company
          </label>
          <div className="flex rounded-md border border-border overflow-hidden text-[11px]">
            <button
              type="button"
              onClick={() => setDensity("comfy")}
              className={`px-2.5 py-1 ${density === "comfy" ? "bg-[var(--brand)] text-white" : "bg-surface text-text-2 hover:bg-[var(--surface-2)]"}`}
            >
              Comfy
            </button>
            <button
              type="button"
              onClick={() => setDensity("compact")}
              className={`px-2.5 py-1 border-l border-border ${density === "compact" ? "bg-[var(--brand)] text-white" : "bg-surface text-text-2 hover:bg-[var(--surface-2)]"}`}
            >
              Compact
            </button>
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="bg-surface border border-border rounded-md overflow-hidden">
        {/* Header */}
        <div className="grid grid-cols-12 gap-3 px-4 py-2.5 bg-[var(--surface-2)] border-b border-border text-[11px] font-semibold text-text-2 uppercase tracking-wider">
          <div className="col-span-9">Job</div>
          <div className="col-span-3 text-right">Actions</div>
        </div>

        {grouped.map((g) => (
          <div key={g.company ?? "all"}>
            {g.company && (
              <div className="px-4 py-1.5 bg-[var(--surface-2)]/60 border-b border-border text-[11px] font-semibold text-text-2 uppercase tracking-wide flex items-center gap-2">
                <span>{g.company}</span>
                <span className="text-text-3 font-normal normal-case">· {g.jobs.length} jobs</span>
              </div>
            )}
            {g.jobs.map((job) => (
              <Row key={job.id} job={job} density={density} />
            ))}
          </div>
        ))}
      </div>

      <p className="mt-4 text-[11px] text-text-3 leading-relaxed">
        Tip: hover any pill or icon for the tooltip explaining what it means.
        <br />
        Try toggling <strong>Compact</strong> — the row collapses to one line per job, useful when scanning a long feed.
      </p>
    </div>
  );
}

// ── row ─────────────────────────────────────────────────────────────────

function Row({ job, density }: { job: MockJob; density: "comfy" | "compact" }) {
  const compact = density === "compact";
  const addedDate = new Date(job.added_iso);
  const addedTooltip = `Added to JobTrackr ${addedDate.toLocaleString("en-AU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`;

  return (
    <div
      className={`grid grid-cols-12 gap-3 px-4 ${compact ? "py-2" : "py-2.5"} border-b border-border last:border-0 hover:bg-[var(--surface-2)]/60 transition-colors ${
        job.is_new ? "border-l-2 border-l-[var(--brand)]" : ""
      }`}
    >
      {/* Job */}
      <div className="col-span-9 min-w-0">
        <div className="flex items-baseline gap-2 min-w-0">
          {job.is_new && (
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--brand)] shrink-0" title="New since your last visit" />
          )}
          <a
            href="#"
            onClick={(e) => e.preventDefault()}
            className="text-[13px] font-semibold text-text hover:text-[var(--brand)] truncate"
          >
            {job.title}
          </a>
          <SourcePill source={job.source} />
          <VisaDot visa={job.visa} />
          {job.jd_quality === "thin" && (
            <ChipWarn label="thin JD" tooltip="JD too short to analyse — click Edit to paste the full description" />
          )}
          {job.possible_duplicate && (
            <ChipWarn label="dup?" tooltip="Possible duplicate of another listing in your feed" />
          )}
          {job.unusual_keyword && (
            <ChipInfo label={job.unusual_keyword} tooltip={`Unusual keyword match — not in your standard search (${SEARCH_KEYWORDS.join(", ")})`} />
          )}
        </div>

        {!compact && (
          <div className="mt-0.5 text-[11px] text-text-2 truncate flex items-center gap-1.5">
            <span className="font-medium text-text-2">{job.company}</span>
            <Sep />
            <span className="truncate">{job.location}</span>
            {typeof job.distance_km === "number" && (
              <>
                <Sep />
                <Distance km={job.distance_km} />
              </>
            )}
            <Sep />
            <span title={addedTooltip}>{job.posted_label}</span>
          </div>
        )}

        {compact && (
          // In compact mode, fold meta to the right of title row by hiding here
          // and showing inline. We render a tiny secondary line only with company
          // + distance to keep one logical row per job.
          <div className="mt-0 text-[10px] text-text-3 truncate flex items-center gap-1.5">
            <span>{job.company}</span>
            <Sep />
            <span className="truncate">{job.location}</span>
            {typeof job.distance_km === "number" && (
              <>
                <Sep />
                <Distance km={job.distance_km} />
              </>
            )}
            <Sep />
            <span title={addedTooltip}>{job.posted_label}</span>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="col-span-3 flex items-center justify-end gap-2">
        <ProgressDots p={job.progress} />
        <button
          type="button"
          className="gh-btn gh-btn-blue text-[11px] py-1 px-2.5"
          onClick={(e) => e.preventDefault()}
        >
          Analyze
        </button>
        <button
          type="button"
          className="p-1 rounded hover:bg-[var(--surface-2)] text-text-3"
          aria-label="More actions"
        >
          <MoreHorizontal className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

// ── tiny presentational helpers ─────────────────────────────────────────

function Sep() {
  return <span className="text-text-3">·</span>;
}

function SourcePill({ source }: { source: MockJob["source"] }) {
  const tone: Record<MockJob["source"], string> = {
    adzuna:     "bg-blue-100 text-blue-700",
    seek:       "bg-blue-100 text-blue-700",
    careerjet:  "bg-teal-100 text-teal-700",
    greenhouse: "bg-purple-100 text-purple-700",
    lever:      "bg-purple-100 text-purple-700",
  };
  return (
    <span
      className={`text-[9px] uppercase font-semibold tracking-wide px-1.5 py-px rounded shrink-0 ${tone[source]}`}
      title={`Source: ${source}`}
    >
      {source}
    </span>
  );
}

function VisaDot({ visa }: { visa: VisaStatus }) {
  const map: Record<VisaStatus, { color: string; tip: string }> = {
    yes:     { color: "bg-green-500",  tip: "Visa sponsorship offered" },
    no:      { color: "bg-red-500",    tip: "No visa sponsorship" },
    pr_only: { color: "bg-amber-500",  tip: "PR or citizens only" },
    unknown: { color: "bg-gray-300",   tip: "Visa info not mentioned — check the JD" },
  };
  const m = map[visa];
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full shrink-0 ${m.color} cursor-help`}
      title={m.tip}
      aria-label={m.tip}
    />
  );
}

function ChipWarn({ label, tooltip }: { label: string; tooltip: string }) {
  return (
    <span
      title={tooltip}
      className="text-[10px] font-medium px-1.5 py-px rounded shrink-0 bg-amber-100 text-amber-800 cursor-help"
    >
      {label}
    </span>
  );
}

function ChipInfo({ label, tooltip }: { label: string; tooltip: string }) {
  return (
    <span
      title={tooltip}
      className="text-[10px] font-medium px-1.5 py-px rounded shrink-0 bg-[var(--surface-2)] text-text-2 border border-border cursor-help"
    >
      {label}
    </span>
  );
}

function Distance({ km }: { km: number }) {
  const tone = km <= 10 ? "text-green-600"
            : km <= 25 ? "text-text-2"
            : km <= 50 ? "text-amber-600"
            : "text-red-600";
  const display = km < 10 ? km.toFixed(1) : Math.round(km);
  return (
    <span className={`tabular-nums font-medium ${tone}`} title="Driving distance from your home address">
      {display} km
    </span>
  );
}

function ProgressDots({ p }: { p: MockJob["progress"] }) {
  const items = [
    { on: p.analysed, Icon: BarChart3,     onClass: "text-blue-600",   label: { on: "Analysed",        off: "Not yet analysed" } },
    { on: p.tailored, Icon: FileText,      onClass: "text-purple-600", label: { on: "Tailored CV",     off: "No tailored CV" } },
    { on: p.cover,    Icon: Mail,          onClass: "text-amber-600",  label: { on: "Cover letter",    off: "No cover letter" } },
    { on: p.applied,  Icon: CheckCircle2,  onClass: "text-green-600",  label: { on: "Applied",         off: "Not applied" } },
  ];
  return (
    <div className="flex items-center gap-1">
      {items.map(({ on, Icon, onClass, label }, i) => (
        <Icon
          key={i}
          className={`w-3.5 h-3.5 ${on ? onClass : "text-text-3 opacity-30"}`}
          strokeWidth={on ? 2.5 : 1.5}
          aria-label={on ? label.on : label.off}
        />
      ))}
    </div>
  );
}

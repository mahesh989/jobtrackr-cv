"use client";

/**
 * Smart-feed beta — replaces the table with curated sections that triage
 * the feed for the user. The "surprise" elements:
 *
 *  1. Distance ribbon at the top: horizontal axis 0→max km, every job is
 *     a dot coloured by visa status. Hover for a peek, click to scroll
 *     the matching card into view.
 *  2. Sections by intent, not by metadata: "Today's picks", "Closest to
 *     you", "Fresh today", "Needs attention", "Everything else". Each
 *     section limits to its most useful subset; the rest collapse.
 *  3. Job cards instead of rows. Title prominent, key facts in one line,
 *     visa as a coloured dot, source as a faint pill. One primary action
 *     (Analyze) per card.
 *
 * Pure UI, mock data, no backend. Safe to ship to prod.
 */

import { useMemo, useRef, useState } from "react";
import { BarChart3, FileText, Mail, CheckCircle2, MapPin, Sparkles, Clock, AlertTriangle, Inbox, ChevronDown } from "lucide-react";

// ── mock data ───────────────────────────────────────────────────────────

type VisaStatus = "yes" | "no" | "pr_only" | "unknown";
type JdQuality = "rich" | "thin" | "unknown";

interface MockJob {
  id: string;
  title: string;
  company: string;
  location: string;
  distance_km: number;
  source: "adzuna" | "seek" | "careerjet" | "greenhouse" | "lever";
  posted_label: string;
  posted_today: boolean;
  added_iso: string;
  visa: VisaStatus;
  jd_quality: JdQuality;
  is_new?: boolean;
  possible_duplicate?: boolean;
  progress: { analysed: boolean; tailored: boolean; cover: boolean; applied: boolean };
}

const HOME_ADDRESS = "40-42 Empress Street, Hurstville NSW";

const JOBS: MockJob[] = [
  { id: "1",  title: "Enrolled Nurse — Killara Glades Care Community",                            company: "Opal HealthCare",              location: "Killara",          distance_km: 30,   source: "adzuna",    posted_label: "6d ago",  posted_today: false, added_iso: "2026-05-21T20:38", visa: "unknown", jd_quality: "thin", is_new: true,  possible_duplicate: true,  progress: { analysed: false, tailored: false, cover: false, applied: false } },
  { id: "2",  title: "Enrolled Nurse (EN) — LGBTQIA Community Supports — Sydney CBD",             company: "Chosen Family",                location: "The Rocks",        distance_km: 22,   source: "adzuna",    posted_label: "1w ago",  posted_today: false, added_iso: "2026-05-20T20:38", visa: "unknown", jd_quality: "thin", progress: { analysed: false, tailored: false, cover: false, applied: false } },
  { id: "3",  title: "Enrolled Nurse | Myhealth Northmead",                                       company: "Myhealth Medical Centres",     location: "Northmead",        distance_km: 28,   source: "adzuna",    posted_label: "1w ago",  posted_today: false, added_iso: "2026-05-20T20:38", visa: "unknown", jd_quality: "thin", progress: { analysed: false, tailored: false, cover: false, applied: false } },
  { id: "4",  title: "Endorsed Enrolled Nurse — Mental Health",                                   company: "Healthscope",                  location: "Bronte",           distance_km: 22,   source: "adzuna",    posted_label: "1w ago",  posted_today: false, added_iso: "2026-05-20T20:38", visa: "unknown", jd_quality: "thin", progress: { analysed: false, tailored: false, cover: false, applied: false } },
  { id: "5",  title: "Enrolled Nurse — Anaesthetics and PACU",                                    company: "Nexus",                        location: "Kogarah",          distance_km: 3.3,  source: "adzuna",    posted_label: "2w ago",  posted_today: false, added_iso: "2026-05-13T20:38", visa: "unknown", jd_quality: "thin", progress: { analysed: false, tailored: false, cover: false, applied: false } },
  { id: "6",  title: "Enrolled Endorsed Nurse",                                                   company: "St Vincent's Health Australia", location: "North Sydney",     distance_km: 24,   source: "careerjet", posted_label: "Today",   posted_today: true,  added_iso: "2026-05-27T20:38", visa: "no",      jd_quality: "rich", is_new: true,  progress: { analysed: false, tailored: false, cover: false, applied: false } },
  { id: "7",  title: "Enrolled Nurse — Permanent Full-time position — Forbes",                    company: "Catholic Healthcare",          location: "Sydney",           distance_km: 21,   source: "careerjet", posted_label: "Today",   posted_today: true,  added_iso: "2026-05-27T20:38", visa: "yes",     jd_quality: "rich", is_new: true,  progress: { analysed: true,  tailored: true,  cover: false, applied: false } },
  { id: "8",  title: "Enrolled Nurse, Community Health",                                          company: "NSW Health",                   location: "Randwick",         distance_km: 19,   source: "careerjet", posted_label: "Today",   posted_today: true,  added_iso: "2026-05-27T20:38", visa: "pr_only", jd_quality: "rich", is_new: true,  progress: { analysed: false, tailored: false, cover: false, applied: false } },
  { id: "9",  title: "Enrolled Nurse — Orthopaedics & ENT — Perm/Temp F/PT",                      company: "NSW Health",                   location: "Caringbah",        distance_km: 9.6,  source: "careerjet", posted_label: "Today",   posted_today: true,  added_iso: "2026-05-27T20:38", visa: "pr_only", jd_quality: "rich", progress: { analysed: false, tailored: false, cover: false, applied: false } },
  { id: "10", title: "Enrolled Nurse Transition Program — St Vincent's Public Hospital",         company: "NSW Health",                   location: "Sydney",           distance_km: 21,   source: "careerjet", posted_label: "Today",   posted_today: true,  added_iso: "2026-05-27T20:38", visa: "no",      jd_quality: "rich", progress: { analysed: true,  tailored: true,  cover: true,  applied: true } },
  { id: "11", title: "Enrolled Nurse — Gastroenterology — The Sutherland Hospital",              company: "NSW Health",                   location: "Caringbah",        distance_km: 9.6,  source: "careerjet", posted_label: "Today",   posted_today: true,  added_iso: "2026-05-27T20:38", visa: "pr_only", jd_quality: "rich", progress: { analysed: false, tailored: false, cover: false, applied: false } },
  { id: "12", title: "Enrolled Nurse — Aged Care",                                                company: "Medacs Healthcare",            location: "Sydney",           distance_km: 42,   source: "adzuna",    posted_label: "2w ago",  posted_today: false, added_iso: "2026-05-13T20:38", visa: "unknown", jd_quality: "thin", progress: { analysed: false, tailored: false, cover: false, applied: false } },
];

// ── helpers ─────────────────────────────────────────────────────────────

function jobScore(j: MockJob): number {
  // Bigger = more interesting. Used for "Today's picks".
  let s = 100;
  s -= Math.min(j.distance_km, 50);           // closer is better
  if (j.visa === "yes")     s += 30;
  if (j.visa === "pr_only") s -= 25;
  if (j.visa === "no")      s -= 40;
  if (j.jd_quality === "thin") s -= 10;
  if (j.posted_today)       s += 10;
  if (j.progress.applied)   s -= 100;          // already done
  return s;
}

// ── component ───────────────────────────────────────────────────────────

export function JobFeedBetaClient() {
  const [expandRest, setExpandRest] = useState(false);
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});

  function scrollToJob(id: string) {
    const el = cardRefs.current[id];
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("ring-2", "ring-[var(--brand)]");
    setTimeout(() => el.classList.remove("ring-2", "ring-[var(--brand)]"), 1500);
  }

  // Bucket jobs into the intent-based sections.
  const buckets = useMemo(() => {
    const undecided = JOBS.filter((j) => !j.progress.applied);

    const todaysPicks = [...undecided]
      .sort((a, b) => jobScore(b) - jobScore(a))
      .slice(0, 3);
    const pickIds = new Set(todaysPicks.map((j) => j.id));

    const closest = undecided
      .filter((j) => !pickIds.has(j.id) && j.distance_km <= 15)
      .sort((a, b) => a.distance_km - b.distance_km);
    const closestIds = new Set(closest.map((j) => j.id));

    const fresh = undecided.filter((j) => !pickIds.has(j.id) && !closestIds.has(j.id) && j.posted_today);
    const freshIds = new Set(fresh.map((j) => j.id));

    const attention = undecided.filter((j) => !pickIds.has(j.id) && !closestIds.has(j.id) && !freshIds.has(j.id) && j.jd_quality === "thin");
    const attentionIds = new Set(attention.map((j) => j.id));

    const rest = undecided.filter((j) => !pickIds.has(j.id) && !closestIds.has(j.id) && !freshIds.has(j.id) && !attentionIds.has(j.id));

    return { todaysPicks, closest, fresh, attention, rest };
  }, []);

  const maxKm = Math.max(...JOBS.map((j) => j.distance_km), 50);

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">

      {/* Beta banner */}
      <div className="mb-5 flex items-start gap-3 p-3 rounded-md border border-[var(--brand)]/30 bg-[#DDF4FF] text-[12px] text-text">
        <span className="inline-flex items-center justify-center w-5 h-5 rounded bg-[var(--brand)] text-white text-[10px] font-bold shrink-0">β</span>
        <div className="min-w-0">
          <p className="font-semibold">Smart feed — preview only</p>
          <p className="text-text-2 mt-0.5 leading-relaxed">
            A different take: no table, no column headers. Jobs grouped by what you should <em>do next</em>,
            with a distance ribbon at the top so you can see the geography at a glance. Hover a dot → see the job. Click → jumps to its card.
          </p>
        </div>
      </div>

      {/* Header */}
      <div className="mb-5">
        <div className="flex items-baseline justify-between gap-3">
          <div>
            <h1 className="text-[18px] font-semibold text-text">Rashmu — Enrolled Nurse</h1>
            <p className="text-[12px] text-text-2 flex items-center gap-1.5 mt-1">
              <MapPin className="w-3 h-3" />
              {HOME_ADDRESS}
            </p>
          </div>
          <div className="text-[12px] text-text-2">
            <strong className="text-text">{JOBS.length}</strong> jobs · <strong className="text-text">{JOBS.filter((j) => j.posted_today).length}</strong> fresh today
          </div>
        </div>
      </div>

      {/* Distance ribbon */}
      <DistanceRibbon jobs={JOBS} maxKm={maxKm} onJobClick={scrollToJob} />

      {/* Sections */}
      <div className="mt-6 space-y-7">

        <Section
          icon={<Sparkles className="w-3.5 h-3.5" />}
          title="Today's picks"
          subtitle="Best matches across distance, visa fit, and JD quality"
          count={buckets.todaysPicks.length}
          tone="brand"
        >
          <div className="grid gap-2.5 sm:grid-cols-1 lg:grid-cols-3">
            {buckets.todaysPicks.map((job) => (
              <HeroCard key={job.id} job={job} refSetter={(el) => { cardRefs.current[job.id] = el; }} />
            ))}
          </div>
        </Section>

        {buckets.closest.length > 0 && (
          <Section
            icon={<MapPin className="w-3.5 h-3.5" />}
            title="Closest to you"
            subtitle="Within 15 km of your home"
            count={buckets.closest.length}
            tone="green"
          >
            <div className="grid gap-2">
              {buckets.closest.map((job) => (
                <Card key={job.id} job={job} refSetter={(el) => { cardRefs.current[job.id] = el; }} />
              ))}
            </div>
          </Section>
        )}

        {buckets.fresh.length > 0 && (
          <Section
            icon={<Clock className="w-3.5 h-3.5" />}
            title="Fresh today"
            subtitle="Posted in the last 24 hours"
            count={buckets.fresh.length}
            tone="brand"
          >
            <div className="grid gap-2">
              {buckets.fresh.map((job) => (
                <Card key={job.id} job={job} refSetter={(el) => { cardRefs.current[job.id] = el; }} />
              ))}
            </div>
          </Section>
        )}

        {buckets.attention.length > 0 && (
          <Section
            icon={<AlertTriangle className="w-3.5 h-3.5" />}
            title="Needs attention"
            subtitle="Thin JDs — paste the full description before analysing"
            count={buckets.attention.length}
            tone="amber"
          >
            <div className="grid gap-2">
              {buckets.attention.map((job) => (
                <Card key={job.id} job={job} refSetter={(el) => { cardRefs.current[job.id] = el; }} />
              ))}
            </div>
          </Section>
        )}

        {buckets.rest.length > 0 && (
          <Section
            icon={<Inbox className="w-3.5 h-3.5" />}
            title="Everything else"
            subtitle="Older or further away — review when you've got time"
            count={buckets.rest.length}
            tone="muted"
            collapsible
            expanded={expandRest}
            onToggle={() => setExpandRest((v) => !v)}
          >
            <div className="grid gap-2">
              {buckets.rest.map((job) => (
                <Card key={job.id} job={job} refSetter={(el) => { cardRefs.current[job.id] = el; }} compact />
              ))}
            </div>
          </Section>
        )}

      </div>
    </div>
  );
}

// ── distance ribbon ─────────────────────────────────────────────────────

function DistanceRibbon({ jobs, maxKm, onJobClick }: {
  jobs: MockJob[];
  maxKm: number;
  onJobClick: (id: string) => void;
}) {
  const width = 100; // viewBox units, %
  // Round max up to next 10
  const axisMax = Math.ceil(maxKm / 10) * 10;
  const ticks = Array.from({ length: axisMax / 10 + 1 }, (_, i) => i * 10);

  const visaColor: Record<VisaStatus, string> = {
    yes:     "#22c55e",
    no:      "#ef4444",
    pr_only: "#f59e0b",
    unknown: "#94a3b8",
  };

  return (
    <div className="rounded-md border border-border bg-[var(--surface-2)] p-4">
      <div className="flex items-center justify-between mb-2">
        <p className="text-[11px] font-semibold text-text-2 uppercase tracking-wider">Distance from home</p>
        <div className="flex items-center gap-3 text-[10px] text-text-2">
          <LegendDot color={visaColor.yes}     label="Sponsored" />
          <LegendDot color={visaColor.unknown} label="Unknown" />
          <LegendDot color={visaColor.pr_only} label="PR only" />
          <LegendDot color={visaColor.no}      label="No sponsor" />
        </div>
      </div>

      <div className="relative h-14">
        {/* Axis */}
        <div className="absolute left-0 right-0 top-7 h-px bg-border" />
        {/* Ticks */}
        {ticks.map((t) => (
          <div key={t} className="absolute top-7" style={{ left: `${(t / axisMax) * width}%` }}>
            <div className="w-px h-1.5 bg-border" />
            <div className="text-[9px] text-text-3 mt-1 -translate-x-1/2 whitespace-nowrap">{t} km</div>
          </div>
        ))}
        {/* Dots — stacked when overlapping */}
        {jobs.map((j, i) => {
          const x = (Math.min(j.distance_km, axisMax) / axisMax) * width;
          // tiny stagger so overlapping dots don't completely hide each other
          const y = 28 + ((i % 3) - 1) * 3;
          return (
            <button
              key={j.id}
              type="button"
              onClick={() => onJobClick(j.id)}
              title={`${j.title}\n${j.company} · ${j.location} · ${j.distance_km < 10 ? j.distance_km.toFixed(1) : Math.round(j.distance_km)} km`}
              className="absolute w-2.5 h-2.5 rounded-full hover:scale-150 transition-transform shadow-sm"
              style={{
                left: `calc(${x}% - 5px)`,
                top: `${y - 5}px`,
                background: visaColor[j.visa],
                borderColor: "white",
                borderWidth: 1,
                borderStyle: "solid",
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="w-2 h-2 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}

// ── section wrapper ─────────────────────────────────────────────────────

function Section({
  icon, title, subtitle, count, children, tone, collapsible, expanded, onToggle,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  count: number;
  children: React.ReactNode;
  tone: "brand" | "green" | "amber" | "muted";
  collapsible?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
}) {
  const toneCls: Record<typeof tone, string> = {
    brand: "text-[var(--brand)]",
    green: "text-green-600",
    amber: "text-amber-600",
    muted: "text-text-2",
  };
  const isOpen = collapsible ? !!expanded : true;

  return (
    <section>
      <button
        type="button"
        onClick={collapsible ? onToggle : undefined}
        className={`w-full flex items-baseline justify-between gap-2 mb-2 ${collapsible ? "cursor-pointer hover:opacity-80" : "cursor-default"}`}
      >
        <div className="flex items-baseline gap-2">
          <span className={`shrink-0 self-center ${toneCls[tone]}`}>{icon}</span>
          <h2 className="text-[13px] font-semibold text-text">{title}</h2>
          <span className="text-[11px] text-text-3 font-medium">{count}</span>
          {subtitle && !collapsible && <span className="text-[11px] text-text-3">— {subtitle}</span>}
        </div>
        {collapsible && (
          <ChevronDown className={`w-4 h-4 text-text-3 transition-transform ${isOpen ? "rotate-180" : ""}`} />
        )}
      </button>
      {isOpen && children}
    </section>
  );
}

// ── hero card (today's picks) ────────────────────────────────────────────

function HeroCard({ job, refSetter }: { job: MockJob; refSetter: (el: HTMLDivElement | null) => void }) {
  return (
    <div
      ref={refSetter}
      className="rounded-lg border-2 border-[var(--brand)]/30 bg-surface p-3.5 hover:border-[var(--brand)] hover:shadow-md transition-all"
    >
      <div className="flex items-center gap-2 mb-2">
        <VisaDot visa={job.visa} />
        <SourcePill source={job.source} />
        <span className="text-[10px] text-text-3 ml-auto">{job.posted_label}</span>
      </div>
      <a
        href="#"
        onClick={(e) => e.preventDefault()}
        className="block text-[13px] font-semibold text-text hover:text-[var(--brand)] leading-snug mb-1.5"
      >
        {job.title}
      </a>
      <p className="text-[11px] text-text-2 mb-2.5">
        {job.company} · {job.location} · <Distance km={job.distance_km} />
      </p>
      <div className="flex items-center justify-between gap-2">
        <ProgressDots p={job.progress} />
        <button type="button" className="gh-btn gh-btn-blue text-[11px] py-1 px-2.5" onClick={(e) => e.preventDefault()}>
          Analyze
        </button>
      </div>
    </div>
  );
}

// ── compact card ─────────────────────────────────────────────────────────

function Card({ job, refSetter, compact }: {
  job: MockJob;
  refSetter: (el: HTMLDivElement | null) => void;
  compact?: boolean;
}) {
  return (
    <div
      ref={refSetter}
      className={`rounded-md border border-border bg-surface hover:bg-[var(--surface-2)]/60 transition-colors ${compact ? "px-3 py-2" : "px-3.5 py-2.5"}`}
    >
      <div className="flex items-center gap-3 min-w-0">
        <VisaDot visa={job.visa} />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 min-w-0">
            <a
              href="#"
              onClick={(e) => e.preventDefault()}
              className="text-[13px] font-semibold text-text hover:text-[var(--brand)] truncate"
            >
              {job.title}
            </a>
            <SourcePill source={job.source} />
            {job.jd_quality === "thin" && <ChipWarn label="thin JD" tooltip="JD too short to analyse" />}
            {job.possible_duplicate && <ChipWarn label="dup?" tooltip="Possible duplicate" />}
          </div>
          <p className="text-[11px] text-text-2 truncate mt-0.5">
            {job.company} · {job.location} · <Distance km={job.distance_km} /> · {job.posted_label}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <ProgressDots p={job.progress} />
          <button type="button" className="gh-btn gh-btn-blue text-[11px] py-1 px-2.5" onClick={(e) => e.preventDefault()}>
            Analyze
          </button>
        </div>
      </div>
    </div>
  );
}

// ── tiny shared bits ────────────────────────────────────────────────────

function VisaDot({ visa }: { visa: VisaStatus }) {
  const map: Record<VisaStatus, { color: string; tip: string }> = {
    yes:     { color: "bg-green-500", tip: "Visa sponsorship offered" },
    no:      { color: "bg-red-500",   tip: "No visa sponsorship" },
    pr_only: { color: "bg-amber-500", tip: "PR or citizens only" },
    unknown: { color: "bg-gray-300",  tip: "Visa info not mentioned" },
  };
  const m = map[visa];
  return <span className={`inline-block w-2.5 h-2.5 rounded-full shrink-0 ${m.color}`} title={m.tip} />;
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
    <span className={`text-[9px] uppercase font-semibold tracking-wide px-1.5 py-px rounded shrink-0 ${tone[source]}`}>
      {source}
    </span>
  );
}

function ChipWarn({ label, tooltip }: { label: string; tooltip: string }) {
  return (
    <span
      title={tooltip}
      className="text-[10px] font-medium px-1.5 py-px rounded shrink-0 bg-amber-100 text-amber-800"
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
  return <span className={`tabular-nums font-medium ${tone}`}>{display} km</span>;
}

function ProgressDots({ p }: { p: MockJob["progress"] }) {
  const items = [
    { on: p.analysed, Icon: BarChart3,    onClass: "text-blue-600",   label: { on: "Analysed",     off: "Not yet analysed" } },
    { on: p.tailored, Icon: FileText,     onClass: "text-purple-600", label: { on: "Tailored CV",  off: "No tailored CV" } },
    { on: p.cover,    Icon: Mail,         onClass: "text-amber-600",  label: { on: "Cover letter", off: "No cover letter" } },
    { on: p.applied,  Icon: CheckCircle2, onClass: "text-green-600",  label: { on: "Applied",      off: "Not applied" } },
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

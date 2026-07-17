import { matchScore, type BoardJob, type AtsBand } from "@/features/jobs/jobFilters";

export function relativeDate(d: string | null): string | null {
  if (!d) return null;
  const diff = Date.now() - new Date(d).getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7)   return `${days}d ago`;
  if (days < 30)  return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

export function clampInt(raw: string | null, lo: number, hi: number, fallback: number): number {
  if (raw == null) return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

export function isPostedToday(j: BoardJob): boolean {
  if (!j.posted_at) return false;
  const d = new Date(j.posted_at);
  const now = new Date();
  return d.getFullYear() === now.getFullYear()
      && d.getMonth()    === now.getMonth()
      && d.getDate()     === now.getDate();
}

export const ATS_BAND_META: Record<AtsBand, { label: string; dot: string; chipBg: string; chipText: string; barColor: string; tip: string }> = {
  above_final:   { label: "≥ 70",  dot: "bg-green-500", chipBg: "bg-green-100",          chipText: "text-green-800", barColor: "bg-green-500", tip: "Passed final gate — auto cover letter eligible" },
  below_final:   { label: "60–69", dot: "bg-amber-500", chipBg: "bg-amber-100",          chipText: "text-amber-800", barColor: "bg-amber-500", tip: "Tailored CV — between gates" },
  below_initial: { label: "< 60",  dot: "bg-red-500",   chipBg: "bg-red-100",            chipText: "text-red-800",   barColor: "bg-red-500",   tip: "Below initial gate — pipeline stopped" },
  no_ats:        { label: "—",     dot: "bg-gray-300",  chipBg: "bg-[var(--surface-2)]", chipText: "text-text-2",    barColor: "bg-gray-400",  tip: "Not yet analysed" },
};

export function getAtsMeta(job: { atsBand: AtsBand; atsThresholds?: { initial: number; final: number } }) {
  const band = job.atsBand;
  const th = job.atsThresholds ?? { initial: 60, final: 70 };
  const staticMeta = ATS_BAND_META[band];
  if (band === "above_final") {
    return { ...staticMeta, label: `≥ ${th.final}`, tip: `Passed final gate (${th.final}) — auto cover letter eligible` };
  }
  if (band === "below_final") {
    return { ...staticMeta, label: `${th.initial}–${th.final - 1}`, tip: `Tailored CV — between gates (${th.initial}–${th.final - 1})` };
  }
  if (band === "below_initial") {
    return { ...staticMeta, label: `< ${th.initial}`, tip: `Below initial gate (${th.initial}) — pipeline stopped` };
  }
  return staticMeta;
}

export const VISA_COLOR = { yes: "#22c55e", no: "#ef4444", pr_only: "#f59e0b", unknown: "#94a3b8" };
export const VISA_LABEL = { yes: "Sponsored", no: "No sponsor", pr_only: "PR or citizens only", unknown: "Visa not mentioned" };

export function visaKey(j: BoardJob): keyof typeof VISA_COLOR {
  if (j.citizen_pr_only === true) return "pr_only";
  if (j.sponsorship_status === "yes") return "yes";
  if (j.sponsorship_status === "no")  return "no";
  return "unknown";
}

export function sourcePillTone(source: string): string {
  const m: Record<string, string> = {
    adzuna:     "bg-[var(--brand)]/12 text-[var(--brand)] border border-[var(--brand)]/25",
    seek:       "bg-[var(--brand)]/12 text-[var(--brand)] border border-[var(--brand)]/25",
    careerjet:  "bg-[var(--teal)]/14 text-[var(--teal)] border border-[var(--teal)]/25",
    greenhouse: "bg-[var(--purple)]/12 text-[var(--purple)] border border-[var(--purple)]/25",
    lever:      "bg-[var(--purple)]/12 text-[var(--purple)] border border-[var(--purple)]/25",
    indeed:     "bg-[var(--amber)]/12 text-[var(--amber)] border border-[var(--amber)]/25",
  };
  return m[source.toLowerCase()] ?? "bg-[var(--surface-2)] text-text-2 border border-border";
}

export function pickScore(j: BoardJob): number {
  return matchScore(j);
}

export function byDistanceAsc(a: BoardJob, b: BoardJob): number {
  const aNull = a.distance_km == null;
  const bNull = b.distance_km == null;
  if (aNull && bNull) return 0;
  if (aNull) return 1;
  if (bNull) return -1;
  return (a.distance_km as number) - (b.distance_km as number);
}

export const EMPLOYMENT_CHIP_LABEL: Record<string, string> = {
  full_time: "FT", part_time: "PT", casual: "Casual",
  contract: "Contract", temporary: "Temp", internship: "Intern",
};

export function formatSalary(job: BoardJob): string | null {
  if (job.salary_min == null) return null;
  const period = job.salary_period;
  const fmt = (v: number) =>
    period === "hour" || period === "day"
      ? `$${v % 1 === 0 ? v : v.toFixed(2)}`
      : v >= 1000 ? `$${Math.round(v / 1000)}k` : `$${v}`;
  const range = job.salary_max != null && job.salary_max !== job.salary_min
    ? `${fmt(job.salary_min)}–${fmt(job.salary_max)}`
    : fmt(job.salary_min);
  const suffix = period === "hour" ? "/hr" : period === "day" ? "/day"
    : period === "week" ? "/wk" : period === "fortnight" ? "/fn" : "";
  return `${range}${suffix}`;
}

export function daysUntilClose(job: BoardJob): number | null {
  if (!job.closing_date) return null;
  const d = Math.ceil((new Date(job.closing_date).getTime() - Date.now()) / 86_400_000);
  return d >= 0 ? d : null;
}

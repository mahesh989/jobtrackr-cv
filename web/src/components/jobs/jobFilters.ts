/**
 * Pure, client-safe job-board filtering + sorting.
 *
 * This is the SAME logic the dashboard server component used to run in-memory
 * after fetching the (capped) job set — extracted so it can run in the browser
 * for instant filtering with no server round-trip. Keep it byte-for-byte
 * equivalent to the server behaviour it replaces.
 *
 * Dataset-narrowing filters (location / posted_within / source / dismissed)
 * still happen server-side because they decide which jobs are in the capped
 * 200 — they are NOT handled here.
 */

import type { Job } from "./JobTable";

export type AtsBand = "above_final" | "below_final" | "below_initial" | "no_ats";

export type BoardJob = Job & {
  atsBand: AtsBand;
  atsThresholds?: { initial: number; final: number };
};

export interface ViewFilters {
  stage:       string;   // analysed | cvReady | letterReady | thinJd | applied | all | dismissed | favourite
  triage:      string;   // needsJd | thinJd | richJd | roleMismatch | belowThreshold | hasEmail | notTailored
  ats:         string;   // above_final | below_final | below_initial | no_ats
  minKeywords: string;   // numeric string
  maxDistance: string;
  minDistance?: string;
  sort?:        string;
}

/** Minimum manual-JD length (chars) that counts as "the user supplied a usable
 *  JD". Mirrors the analyze route's hasManualJd bar so the UI, counts, and the
 *  server analyze gate all agree on when a paste unblocks a thin job. The
 *  1000-char floor reflects what a real job description looks like — anything
 *  shorter is almost certainly a paste of the role title + a sentence or two
 *  rather than a usable JD for the tailoring pipeline. */
export const MANUAL_JD_MIN_CHARS = 1000;

/**
 * Whether a job still needs a JD pasted: it's classified 'thin' AND the user
 * hasn't already pasted a usable manual JD. Single source of truth shared by
 * the filter, the card badges, the "Needs attention" bucket, and the funnel
 * counts so they never disagree.
 */
export function jobNeedsJd(job: { jd_quality?: string | null; manual_jd_text?: string | null }): boolean {
  if (job.jd_quality !== "thin") return false;
  return (job.manual_jd_text ?? "").trim().length < MANUAL_JD_MIN_CHARS;
}

/**
 * Compute a job's ATS band from its run's recomputed gates (server-side helper,
 * mirrors the dashboard donut's ATS lens buckets exactly):
 *   passedFinal === true                     -> above_final
 *   passedFinal !== true && passedInitial    -> below_final
 *   passedFinal !== true && !passedInitial   -> below_initial
 *   no run                                   -> no_ats
 */
export function atsBandFor(
  hasRun: boolean,
  initialScore: number | null | undefined,
  tailoredScore: number | null | undefined,
  minInitial: number,
  minFinal: number,
): AtsBand {
  if (!hasRun) return "no_ats";
  const score = tailoredScore ?? initialScore ?? null;
  if (score === null) return "no_ats";
  if (score >= minFinal) return "above_final";
  if (score >= minInitial) return "below_final";
  return "below_initial";
}

/** Apply the view filters (stage / triage / ATS band / min-keywords) in-memory. */
export function filterJobs(jobs: BoardJob[], f: ViewFilters): BoardJob[] {
  let out = jobs;

  // If sorting by last analysed, restrict to analysed jobs only
  if (f.sort === "last_analysed") {
    out = out.filter((x) => x.progress.has_analysis);
  }

  // Stage (dismissed + all are no-ops here — dismissed is fetched server-side,
  // all means no narrowing). Analysed and Recently-analysed share the same
  // membership test (has_analysis) — they differ only in how the SmartFeed
  // groups + sorts them downstream (flat distance vs. adaptive time bucket).
  if (f.stage === "analysed" || f.stage === "recentlyAnalysed")
                                     out = out.filter((x) => x.progress.has_analysis);
  else if (f.stage === "cvReady")    out = out.filter((x) => x.progress.has_tailored_cv);
  else if (f.stage === "letterReady")out = out.filter((x) => x.progress.has_cover_letter);
  else if (f.stage === "thinJd")     out = out.filter(jobNeedsJd);
  else if (f.stage === "applied")    out = out.filter((x) => x.applied_at != null);
  else if (f.stage === "favourite")  out = out.filter((x) => x.starred_at != null);

  // Triage sub-filter
  if (f.triage === "needsJd" || f.triage === "thinJd") out = out.filter(jobNeedsJd);
  else if (f.triage === "richJd")        out = out.filter((x) => x.jd_quality === "rich" || (x.jd_quality === "thin" && !jobNeedsJd(x)));
  else if (f.triage === "roleMismatch")  out = out.filter((x) => x.role_match === "mismatch");
  else if (f.triage === "belowThreshold")out = out.filter((x) => x.pipelineState === "below_initial" || x.pipelineState === "below_final");
  else if (f.triage === "hasEmail")      out = out.filter((x) => x.has_email === true);
  else if (f.triage === "notTailored")   out = out.filter((x) => !x.progress.has_tailored_cv);

  // ATS band
  if (f.ats) out = out.filter((x) => x.atsBand === f.ats);

  // Min keywords matched
  if (f.minKeywords) {
    const minK = parseInt(f.minKeywords, 10);
    if (!isNaN(minK)) out = out.filter((x) => (x.keywords_matched?.length ?? 0) >= minK);
  }

  // Distance cap. Jobs with unresolved distance (null) pass through — they
  // sort to the bottom by default and the chip is simply absent.
  if (f.maxDistance) {
    const maxKm = parseFloat(f.maxDistance);
    if (!isNaN(maxKm)) {
      out = out.filter((x) => x.distance_km == null || x.distance_km <= maxKm);
    }
  }

  // Distance lower bound — paired with maxDistance to form the
  // DistanceRibbon range slider. Same null-keeps-it semantics.
  if (f.minDistance) {
    const minKm = parseFloat(f.minDistance);
    if (!isNaN(minKm) && minKm > 0) {
      out = out.filter((x) => x.distance_km == null || x.distance_km >= minKm);
    }
  }

  return out;
}

/** Sort in-memory. Mirrors the server's sort handling; `asc` = ascending. */
export function sortJobs(jobs: BoardJob[], sortCol: string, asc: boolean): BoardJob[] {
  const arr = [...jobs];

  if (sortCol === "rich_jd_first") {
    const rank: Record<string, number> = { rich: 1, unknown: 2, thin: 3 };
    return arr.sort((a, b) => {
      const aR = rank[a.jd_quality ?? ""] ?? 4;
      const bR = rank[b.jd_quality ?? ""] ?? 4;
      if (aR !== bR) return asc ? bR - aR : aR - bR;
      return (b.posted_at ?? "").localeCompare(a.posted_at ?? "");
    });
  }
  if (sortCol === "last_analysed") {
    // Most recently analysed first. Jobs with no analysis float to the bottom.
    return arr.sort((a, b) => {
      const aT = a.progress.last_progress_at ?? "";
      const bT = b.progress.last_progress_at ?? "";
      // has_analysis check — unanalysed jobs always go below analysed ones.
      if (a.progress.has_analysis && !b.progress.has_analysis) return -1;
      if (!a.progress.has_analysis && b.progress.has_analysis) return 1;
      return asc ? aT.localeCompare(bT) : bT.localeCompare(aT);
    });
  }
  if (sortCol === "recently_progressed") {
    return arr.sort((a, b) => {
      const aT = a.progress.last_progress_at ?? "";
      const bT = b.progress.last_progress_at ?? "";
      return asc ? aT.localeCompare(bT) : bT.localeCompare(aT);
    });
  }
  if (sortCol === "most_progressed") {
    return arr.sort((a, b) => {
      const ds = b.progress.progress_score - a.progress.progress_score;
      if (ds !== 0) return asc ? -ds : ds;
      const aT = a.progress.last_progress_at ?? "";
      const bT = b.progress.last_progress_at ?? "";
      return asc ? aT.localeCompare(bT) : bT.localeCompare(aT);
    });
  }

  // Standard column sorts (title / company / location / posted_at / created_at /
  // visa_likelihood / distance / ats_score). Default falls back to posted_at desc.
  const dir = asc ? 1 : -1;
  if (sortCol === "distance") {
    // Distance always sorts ascending (closest at top) regardless of the
    // requested direction — descending "Distance (nearest)" is not a meaningful
    // affordance and previously surfaced furthest-first by accident. Null
    // distance always sorts to the bottom so an unresolved location can't
    // accidentally claim a top slot.
    return arr.sort((a, b) => {
      const aNull = a.distance_km == null;
      const bNull = b.distance_km == null;
      if (aNull && bNull) return 0;
      if (aNull) return 1;
      if (bNull) return -1;
      return (a.distance_km as number) - (b.distance_km as number);
    });
  }
  if (sortCol === "ats_score") {
    // Ascending = lowest score within band first (the "find the borderline
    // ones" use case driving the ATS chips). Nulls sort to the bottom.
    return arr.sort((a, b) => {
      const aScore = a.tailored_match_score ?? a.initial_ats_score ?? null;
      const bScore = b.tailored_match_score ?? b.initial_ats_score ?? null;
      if (aScore == null && bScore == null) return 0;
      if (aScore == null) return 1;
      if (bScore == null) return -1;
      return dir * (aScore - bScore);
    });
  }
  if (sortCol === "visa_likelihood") {
    return arr.sort((a, b) => dir * ((a.visa_likelihood ?? -1) - (b.visa_likelihood ?? -1)));
  }
  if (sortCol === "title" || sortCol === "company" || sortCol === "location") {
    return arr.sort((a, b) => dir * String(a[sortCol] ?? "").localeCompare(String(b[sortCol] ?? "")));
  }
  if (sortCol === "created_at") {
    return arr.sort((a, b) => dir * (a.created_at ?? "").localeCompare(b.created_at ?? ""));
  }
  // posted_at (default)
  return arr.sort((a, b) => dir * (a.posted_at ?? "").localeCompare(b.posted_at ?? ""));
}

// ───────────────────────────────────────────────────────────────────────────
// Grouping helpers (distance / time-since)
// ───────────────────────────────────────────────────────────────────────────

export interface JobGroup {
  id:    string;
  label: string;
  /** Optional small caption shown after the heading. */
  caption?: string;
  /** Jobs in this group, in the order they should render. */
  jobs:  BoardJob[];
}

/** Bucket jobs into three distance bands (<10 km · 10–25 km · >25 km) plus
 *  an "unknown distance" bucket. Bands are always rendered in nearest-first
 *  order; empty bands are omitted. The "unknown" bucket falls to the bottom
 *  so unresolved locations never claim the top slot. Jobs inside each band
 *  preserve the caller's incoming order (already sorted by `sortJobs`). */
export function groupByDistance(jobs: BoardJob[]): JobGroup[] {
  const near:   BoardJob[] = [];
  const mid:    BoardJob[] = [];
  const far:    BoardJob[] = [];
  const noDist: BoardJob[] = [];

  for (const j of jobs) {
    const d = j.distance_km;
    if (d == null)        noDist.push(j);
    else if (d < 10)      near.push(j);
    else if (d <= 25)     mid.push(j);
    else                  far.push(j);
  }

  const out: JobGroup[] = [];
  if (near.length)   out.push({ id: "near",   label: "Nearby",        caption: "Within 10 km",       jobs: near });
  if (mid.length)    out.push({ id: "mid",    label: "Mid-range",     caption: "10–25 km",           jobs: mid });
  if (far.length)    out.push({ id: "far",    label: "Further out",   caption: "Over 25 km",         jobs: far });
  if (noDist.length) out.push({ id: "noDist", label: "Unknown distance", caption: "No home address or unresolved", jobs: noDist });
  return out;
}

/** Per-job adaptive time bucket. The bucket scale grows with the job's own
 *  age so headings stay readable: under 1 h → 5-minute windows; under 24 h →
 *  1-hour windows; otherwise day windows. Returns a stable sort key (newest
 *  first when sorted descending) and a human label. */
function timeBucketFor(ts: string | null | undefined, now: number): { key: number; label: string } | null {
  if (!ts) return null;
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return null;
  const ageMs = Math.max(0, now - t);
  const FIVE_MIN = 5 * 60 * 1000;
  const ONE_HOUR = 60 * 60 * 1000;
  const ONE_DAY  = 24 * ONE_HOUR;

  // 0–60 min → 5-minute windows, newest-first key
  if (ageMs < ONE_HOUR) {
    const bucket = Math.floor(ageMs / FIVE_MIN); // 0 = last 5 min
    const startMin = bucket * 5;
    const endMin   = startMin + 5;
    const label = startMin === 0 ? "Last 5 minutes" : `${startMin}–${endMin} minutes ago`;
    return { key: bucket, label };
  }

  // 1–24 h → 1-hour windows
  if (ageMs < ONE_DAY) {
    const hours = Math.floor(ageMs / ONE_HOUR);
    // Offset keys past the 5-min range so they sort after the recent buckets.
    const key = 100 + hours;
    const label = hours === 1 ? "1 hour ago" : `${hours} hours ago`;
    return { key, label };
  }

  // ≥1 day → day windows
  const days = Math.floor(ageMs / ONE_DAY);
  const key = 10_000 + days;
  let label: string;
  if (days === 1)      label = "Yesterday";
  else if (days < 7)   label = `${days} days ago`;
  else if (days < 14)  label = "Last week";
  else if (days < 30)  label = `${days} days ago`;
  else if (days < 60)  label = "Last month";
  else                 label = `${Math.floor(days / 30)} months ago`;
  return { key, label };
}

/** Bucket jobs by an adaptive time axis (per-job scale: 5-min → hourly →
 *  daily). Pass `field="last_progress_at"` for "Analysed" (when was it last
 *  worked on) and `field="posted_at"` for "Not analysed" (how fresh is the
 *  listing). Buckets render newest-first. Jobs missing the timestamp fall
 *  into an "Unknown time" bucket at the bottom. */
export function groupByTime(
  jobs: BoardJob[],
  field: "last_progress_at" | "posted_at",
): JobGroup[] {
  const now = Date.now();
  const buckets = new Map<number, { label: string; jobs: BoardJob[] }>();
  const unknown: BoardJob[] = [];

  for (const j of jobs) {
    const ts =
      field === "last_progress_at"
        ? j.progress?.last_progress_at
        : j.posted_at;
    const b = timeBucketFor(ts ?? null, now);
    if (!b) { unknown.push(j); continue; }
    const slot = buckets.get(b.key);
    if (slot) slot.jobs.push(j);
    else buckets.set(b.key, { label: b.label, jobs: [j] });
  }

  // Inside each time bucket, sort by distance ascending (closest first). This
  // is independent of the parent's incoming sort — the time bucket is the
  // structural axis, distance is the within-bucket order. Stable as time
  // passes because the comparator only reads j.distance_km (immutable for the
  // jobs in a bucket) — re-bucketing as a job ages doesn't reorder the others.
  const byDistAsc = (a: BoardJob, b: BoardJob): number => {
    const aNull = a.distance_km == null;
    const bNull = b.distance_km == null;
    if (aNull && bNull) return 0;
    if (aNull) return 1;
    if (bNull) return -1;
    return (a.distance_km as number) - (b.distance_km as number);
  };

  const out: JobGroup[] = [];
  // Sort buckets newest-first (smaller key = more recent).
  const keys = Array.from(buckets.keys()).sort((a, b) => a - b);
  for (const k of keys) {
    const slot = buckets.get(k)!;
    slot.jobs.sort(byDistAsc);
    out.push({ id: `t${k}`, label: slot.label, jobs: slot.jobs });
  }
  if (unknown.length) {
    unknown.sort(byDistAsc);
    out.push({ id: "tUnknown", label: "Unknown time", jobs: unknown });
  }
  return out;
}

/** Decide whether the board should be rendered as labelled groups, and
 *  which mode. Returns null when no grouping should be applied.
 *
 *  Mode rules (industry-grade defaults — predictable and stable):
 *    • Analysed     → time buckets keyed on `last_progress_at`
 *    • Not analysed → time buckets keyed on `posted_at`
 *    • CV ready / Letter ready / Applied → distance buckets
 *    • sort=distance OR sort=ats_score  → matching bucketing (distance/ATS)
 *
 *  Grouping is structural — once a mode is picked it stays on even if the
 *  user changes the sort dropdown. The sort then orders jobs *inside* each
 *  bucket. */
export type GroupMode =
  | { kind: "time"; field: "last_progress_at" | "posted_at" }
  | { kind: "distance" };

export function pickGroupMode(args: {
  stage: string;
  ats:   string;
  sortCol: string;
}): GroupMode | null {
  const { stage, ats, sortCol } = args;
  // "Recently analysed" → time buckets keyed on last_progress_at (the
  // "when did this last move" lens). "Analysed" (stage=analysed) is the
  // flat distance-sorted view — no grouping at all.
  if (stage === "recentlyAnalysed") return { kind: "time", field: "last_progress_at" };
  if (ats === "no_ats")     return { kind: "time", field: "posted_at" };
  if (stage === "cvReady" || stage === "letterReady" || stage === "applied")
    return { kind: "distance" };
  if (sortCol === "distance") return { kind: "distance" };
  return null;
}

/** Build the groups for a given mode. Returns null when the mode is null
 *  (caller should render the flat list / smart sections instead). */
export function buildGroups(jobs: BoardJob[], mode: GroupMode | null): JobGroup[] | null {
  if (!mode) return null;
  if (mode.kind === "distance") return groupByDistance(jobs);
  return groupByTime(jobs, mode.field);
}

/** Human labels for the active view filter (used by the board heading). */
export const FILTER_LABELS: Record<string, string> = {
  analysed: "Analysed", recentlyAnalysed: "Recently analysed",
  cvReady: "CV ready", letterReady: "Letter ready",
  thinJd: "Thin JD", applied: "Applied", dismissed: "Archived",
  richJd: "Full JD", roleMismatch: "Role mismatch", belowThreshold: "Below threshold",
  hasEmail: "Has email", notTailored: "Not tailored", needsJd: "Thin JD",
  above_final: "Above final", below_final: "Below final",
  below_initial: "Below initial", no_ats: "No ATS",
};

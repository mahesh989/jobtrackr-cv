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

/** A board job carries its precomputed ATS band so the client can filter
 *  by it without re-deriving gates. */
export type BoardJob = Job & { atsBand: AtsBand };

export interface ViewFilters {
  stage:       string;   // analysed | cvReady | letterReady | thinJd | applied | all | dismissed
  triage:      string;   // needsJd | thinJd | richJd | roleMismatch | belowThreshold | hasEmail | notTailored
  ats:         string;   // above_final | below_final | below_initial | no_ats
  minKeywords: string;   // numeric string
  /** "Within X km" — numeric string. Jobs with null distance_km are kept
   *  (we don't punish unresolved jobs by hiding them). Empty = no filter. */
  maxDistance: string;
  /** Lower bound for distance, used by the DistanceRibbon's range slider.
   *  Jobs with null distance_km are kept. Empty = no lower bound. */
  minDistance?: string;
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
  passedInitial: boolean | null,
  passedFinal: boolean | null,
): AtsBand {
  if (!hasRun) return "no_ats";
  if (passedFinal === true) return "above_final";
  if (passedInitial) return "below_final";
  return "below_initial";
}

/** Apply the view filters (stage / triage / ATS band / min-keywords) in-memory. */
export function filterJobs(jobs: BoardJob[], f: ViewFilters): BoardJob[] {
  let out = jobs;

  // Stage (dismissed + all are no-ops here — dismissed is fetched server-side,
  // all means no narrowing).
  if (f.stage === "analysed")        out = out.filter((x) => x.progress.has_analysis);
  else if (f.stage === "cvReady")    out = out.filter((x) => x.progress.has_tailored_cv);
  else if (f.stage === "letterReady")out = out.filter((x) => x.progress.has_cover_letter);
  else if (f.stage === "thinJd")     out = out.filter((x) => x.jd_quality === "thin");
  else if (f.stage === "applied")    out = out.filter((x) => x.applied_at != null);

  // Triage sub-filter
  if (f.triage === "needsJd" || f.triage === "thinJd") out = out.filter((x) => x.jd_quality === "thin");
  else if (f.triage === "richJd")        out = out.filter((x) => x.jd_quality === "rich");
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
  // visa_likelihood / distance). Default falls back to posted_at desc.
  const dir = asc ? 1 : -1;
  if (sortCol === "distance") {
    // Resolved distances first, sorted ascending by default (closest at top).
    // Null distance always sorts to the bottom regardless of direction so an
    // unresolved location can't accidentally claim a top slot.
    return arr.sort((a, b) => {
      const aNull = a.distance_km == null;
      const bNull = b.distance_km == null;
      if (aNull && bNull) return 0;
      if (aNull) return 1;
      if (bNull) return -1;
      return dir * ((a.distance_km as number) - (b.distance_km as number));
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

/** Human labels for the active view filter (used by the board heading). */
export const FILTER_LABELS: Record<string, string> = {
  analysed: "Analysed", cvReady: "CV ready", letterReady: "Letter ready",
  thinJd: "Thin JD", applied: "Applied", dismissed: "Archived",
  richJd: "Full JD", roleMismatch: "Role mismatch", belowThreshold: "Below threshold",
  hasEmail: "Has email", notTailored: "Not tailored", needsJd: "Thin JD",
  above_final: "Above final", below_final: "Below final",
  below_initial: "Below initial", no_ats: "No ATS",
};

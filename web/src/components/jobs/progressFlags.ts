/**
 * Job-board progress derivation helpers.
 *
 * Pure functions — no React, no Supabase. Take raw rows from
 * `analysis_runs` and `cover_letters`, return a small struct of 4
 * boolean progress flags + a score + the most-recent timestamp.
 *
 * Single source of truth for: JobTable (progress column),
 * JobProgressChips (counts), ContinueRail (sort by last_progress_at),
 * the jobs page (chip filter + sort).
 *
 * At million-user scale, the four booleans here should be denormalised
 * onto `jobs` via triggers (migration 031 — designed, not built) so
 * the join can be replaced by a single indexed scan. This file's
 * contract stays the same either way.
 */

export interface AnalysisRunRef {
  id:                          string;
  job_id:                      string;
  status:                      string | null;
  tailored_pdf_storage_path:   string | null;
  tailored_cv_storage_path:    string | null;
  completed_at:                string | null;
  created_at:                  string;
  // Phase A gate columns — null until Phase C populates them on
  // user-initiated or automated runs.
  initial_ats_score?:          number  | null;
  tailored_match_score?:       number  | null;
  passed_initial_gate?:        boolean | null;
  passed_final_gate?:          boolean | null;
  automation?:                 boolean | null;
}

export interface CoverLetterRef {
  id:           string;
  job_id:       string;
  status:       string | null;
  completed_at: string | null;
  created_at:   string;
}

export interface JobProgress {
  has_analysis:         boolean;
  has_tailored_cv:      boolean;
  has_cover_letter:     boolean;
  is_applied:           boolean;
  /** 0..4 — count of true progress flags. Used by "Most progressed" sort. */
  progress_score:       number;
  /**
   * ISO timestamp of the most recent meaningful progress event:
   *   max(run.completed_at, letter.completed_at, job.applied_at)
   * Falls back to null when nothing has happened yet.
   * Used by "Recently progressed" sort + Continue rail ordering.
   */
  last_progress_at:     string | null;
  latest_run_id:        string | null;
  latest_run_status:    string | null;
  latest_letter_id:     string | null;
  latest_letter_status: string | null;
}

export function deriveProgress(
  job:    { applied_at: string | null },
  run:    AnalysisRunRef | undefined,
  letter: CoverLetterRef | undefined,
): JobProgress {
  const has_analysis     = run?.status === "completed";
  const has_tailored_cv  = !!(run?.tailored_pdf_storage_path || run?.tailored_cv_storage_path);
  const has_cover_letter = letter?.status === "completed";
  const is_applied       = !!job.applied_at;

  const progress_score =
    (has_analysis     ? 1 : 0) +
    (has_tailored_cv  ? 1 : 0) +
    (has_cover_letter ? 1 : 0) +
    (is_applied       ? 1 : 0);

  const candidates = [
    run?.completed_at,
    letter?.completed_at,
    job.applied_at,
  ].filter((x): x is string => typeof x === "string" && x.length > 0);
  const last_progress_at =
    candidates.length > 0
      ? candidates.reduce((acc, t) => (t > acc ? t : acc))
      : null;

  return {
    has_analysis,
    has_tailored_cv,
    has_cover_letter,
    is_applied,
    progress_score,
    last_progress_at,
    latest_run_id:        run?.id ?? null,
    latest_run_status:    run?.status ?? null,
    latest_letter_id:     letter?.id ?? null,
    latest_letter_status: letter?.status ?? null,
  };
}

/**
 * Build a Map<job_id, latestRow> taking the FIRST row per job_id from
 * a list already ordered by created_at DESC.
 */
export function indexLatestByJob<T extends { job_id: string }>(
  rows: T[] | null | undefined,
): Map<string, T> {
  const m = new Map<string, T>();
  for (const r of rows ?? []) {
    if (!m.has(r.job_id)) m.set(r.job_id, r);
  }
  return m;
}

/** Suggest the single next action for a job based on its progress. */
export function nextAction(
  job: { id: string; profile_id?: string },
  p:   JobProgress,
): { label: string; href: string | null; key: string } {
  if (p.is_applied) {
    return { label: "View analysis", key: "view",
             href: p.latest_run_id ? `/dashboard/jobs/${job.id}/analyze/${p.latest_run_id}` : null };
  }
  if (p.has_cover_letter) {
    return { label: "Mark applied", key: "apply",
             href: p.latest_run_id ? `/dashboard/jobs/${job.id}/analyze/${p.latest_run_id}` : null };
  }
  if (p.has_tailored_cv) {
    return { label: "Generate letter", key: "letter",
             href: p.latest_run_id ? `/dashboard/jobs/${job.id}/analyze/${p.latest_run_id}` : null };
  }
  if (p.has_analysis) {
    return { label: "Continue analysis", key: "continue",
             href: p.latest_run_id ? `/dashboard/jobs/${job.id}/analyze/${p.latest_run_id}` : null };
  }
  return { label: "Analyse now", key: "analyse", href: null };
}

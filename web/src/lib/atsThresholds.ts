/**
 * Global ATS gate thresholds.
 *
 * Single source of truth for the entire app. Per-profile overrides were
 * removed in migration 041 — the rule is now uniform across the user's
 * profiles.
 *
 * The gates work like this in the pipeline:
 *   1. INITIAL gate (after deterministic ATS scoring, before tailoring):
 *        initial_ats_score >= MIN_INITIAL_ATS ? continue : early-stop
 *      Saves ~3 AI calls per low-match job.
 *   2. FINAL gate (after tailoring + rescoring):
 *        tailored_match_score >= MIN_FINAL_ATS ? auto-cover-letter : skip
 *
 * cv-backend's AnalyzeRequest schema defaults to the same values. Web +
 * worker no longer send these in the analyse payload — cv-backend uses
 * the defaults.
 */
export const MIN_INITIAL_ATS = 60;
export const MIN_FINAL_ATS   = 70;

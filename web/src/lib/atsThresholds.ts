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

export interface AtsThresholds {
  initial: number;
  final:   number;
}

/**
 * Per-vertical fixed cutoff overrides. Care/nursing JDs legitimately score
 * lower on the deterministic ATS scorer (more off-axis transferable matches),
 * so the global 60/70 buckets genuine matches as "below final". Healthcare
 * profiles get a lower fixed pair.
 *
 * Keyed by the search-profile `target_verticals` value ("healthcare" is the
 * nursing/care sourcing vertical — there is no separate "nursing" vertical).
 * Everything else falls through to the global 60/70.
 */
const VERTICAL_THRESHOLDS: Record<string, AtsThresholds> = {
  healthcare: { initial: 55, final: 65 },
};

/**
 * Resolve the ATS cutoffs for a search profile from its target_verticals.
 * First matching vertical wins; otherwise the global default. Pure + safe to
 * call anywhere (analyze payload, worker, live re-bucketing on the board).
 */
export function resolveThresholds(verticals?: string[] | null): AtsThresholds {
  for (const v of verticals ?? []) {
    const hit = VERTICAL_THRESHOLDS[v];
    if (hit) return hit;
  }
  return { initial: MIN_INITIAL_ATS, final: MIN_FINAL_ATS };
}

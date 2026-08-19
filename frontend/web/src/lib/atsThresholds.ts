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
 * cv-backend's AnalyzeRequest schema has its own (different) fallback
 * defaults, but both live callers — lib/analyze/start.ts and the worker's
 * automation/triggerAutoAnalyze.ts — always send min_initial_ats/
 * min_final_ats explicitly via resolveThresholds() below, so those schema
 * defaults are a safety net, never the effective value. The one exception
 * was the resume route, which omitted min_final_ats and silently fell back
 * to the schema default (70) instead of the vertical's real gate — fixed to
 * send it explicitly too.
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
 * profiles get a lower fixed pair so that genuine residential AIN matches
 * (which honestly score 40–60 on the deterministic scorer for sub-12-month
 * candidates) clear the initial gate and proceed to tailoring.
 *
 * Keyed by BOTH vertical identifiers, because resolveThresholds is called with
 * EITHER source: the search-profile sourcing vertical ("healthcare", from
 * target_verticals) OR the My CV role_family ("nursing", from
 * contact_details.role_families). The analyze route PREFERS role_families, so
 * keying only "healthcare" made nursing CVs silently fall back to the global
 * 60/70 — the "57% stopped at the 60% gate" bug. Keep both rows in sync.
 * Everything else falls through to the global 60/70.
 */
const VERTICAL_THRESHOLDS: Record<string, AtsThresholds> = {
  healthcare: { initial: 40, final: 60 },
  nursing:    { initial: 40, final: 60 },
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

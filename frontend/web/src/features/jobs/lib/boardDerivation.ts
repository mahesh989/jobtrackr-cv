/**
 * Shared per-job board derivation — the block both server pages
 * (app/(dashboard)/dashboard/page.tsx and profiles/[id]/jobs/page.tsx)
 * previously duplicated inline (audit batch 5.4).
 *
 * Given a raw jobs row + its latest non-stale run/letter + the profile's
 * live ATS thresholds, produces the common BoardJob decoration:
 *   progress          — deriveProgress (has_analysis / has_tailored_cv / …)
 *   pipelineState     — derivePipelineState with gates recomputed LIVE from
 *                       stored scores vs the CURRENT thresholds, so state
 *                       badges reflect threshold changes without re-analysis
 *   atsBand           — atsBandFor (mirrors the donut's ATS lens buckets)
 *   atsThresholds     — passed through for client-side chip labels
 *   initial/tailored scores — denormalised for instant client filtering
 *
 * Page-specific extras (dashboard: profile_name; profile board:
 * eligibility + hours_cap_conflict) are spread by the caller on top.
 */

import {
  deriveProgress,
  type AnalysisRunRef,
  type CoverLetterRef,
} from "./progressFlags";
import { derivePipelineState, recomputeGates } from "./pipelineState";
import { atsBandFor, type BoardJob } from "./jobFilters";

export interface BoardThresholds { initial: number; final: number }

/** Minimal raw-row shape the derivation reads (jobs table row superset). */
export interface RawBoardRow {
  id:            string;
  applied_at:    string | null;
  dismissed_at?: string | null;
  has_email?:    boolean | null;
  jd_quality?:   string | null;
  role_match?:   string | null;
}

export function deriveBoardJob<J extends RawBoardRow>(
  j: J,
  run: AnalysisRunRef | undefined,
  letter: CoverLetterRef | undefined,
  th: BoardThresholds,
): BoardJob {
  const progress = deriveProgress({ applied_at: j.applied_at }, run, letter);

  // Recompute gates LIVE from stored scores vs the current thresholds, so
  // state badges reflect threshold changes without re-analysis.
  const g = run ? recomputeGates(run.initial_ats_score, run.tailored_match_score, th.initial, th.final) : null;
  const liveRun = run && g
    ? { ...run, passed_initial_gate: g.passedInitial, passed_final_gate: g.passedFinal }
    : run;

  const pipelineState = derivePipelineState({
    job: {
      applied_at:   j.applied_at,
      dismissed_at: j.dismissed_at ?? null,
      has_email:    j.has_email    ?? null,
      jd_quality:   j.jd_quality   ?? null,
      role_match:   j.role_match   ?? null,
    },
    latestRun:    liveRun,
    latestLetter: letter,
  });

  // Precompute the ATS band so the client can filter by it without re-deriving
  // gates (mirrors the donut's ATS lens buckets exactly).
  const atsBand = atsBandFor(
    !!run,
    run?.initial_ats_score ?? null,
    run?.tailored_match_score ?? null,
    th.initial,
    th.final,
  );

  return {
    ...(j as unknown as BoardJob),
    progress,
    pipelineState,
    atsBand,
    atsThresholds:        th,
    initial_ats_score:    run?.initial_ats_score    ?? null,
    tailored_match_score: run?.tailored_match_score ?? null,
  };
}

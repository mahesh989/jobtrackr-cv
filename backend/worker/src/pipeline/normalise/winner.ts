// Pick which of N candidate-duplicate jobs to keep.
//
// Higher score wins. Ties broken by created_at (older first — already saved).
//
// Heuristics:
//   - SEEK is preferred for AU (our JD fetcher gives full job descriptions)
//   - Greenhouse / Lever ATS APIs return clean full JDs
//   - Adzuna gives ~500-char teasers, but better than Jora's snippet
//   - Jora often returns 12-50 char snippets — last resort
//   - Salary present > absent
//   - Visa info present > "not_mentioned"
//   - Longer description ≈ more signal

import type { NormalisedJob } from "../types.js";

const SOURCE_BONUS: Record<string, number> = {
  seek:       2000,
  greenhouse: 1500,
  lever:      1500,
  careerjet:  1800,   // Long full-JD descriptions (5-14k chars) via /jobad/<hash>
  adzuna:      400,
  jora:        100,
};

export function scoreJob(job: NormalisedJob): number {
  let s = 0;
  s += Math.min(job.description?.length ?? 0, 5000);
  s += SOURCE_BONUS[job.source] ?? 0;
  if (job.salary_min || job.salary_max) s += 500;

  // Visa signal beyond default
  const sponsorship = (job as { sponsorship_status?: string }).sponsorship_status;
  if (sponsorship && sponsorship !== "not_mentioned") s += 200;

  // Freshness (small effect — listings expire fast)
  if (job.posted_at) {
    const ageDays = (Date.now() - new Date(job.posted_at).getTime()) / 86_400_000;
    if (ageDays < 3) s += 100;
  }
  return s;
}

/**
 * Given a group of candidate-duplicate jobs (same bucket key + matching
 * company prefix), pick the winner and label the rest.
 *
 * Returns:
 *   winner   — the job to keep as "original"
 *   strongLosers — drop entirely (same city as winner)
 *   weakLosers   — keep, mark "possible_duplicate" → UI badge (different city)
 */
export function resolveDuplicates(
  group: NormalisedJob[],
  winnerCity: (j: NormalisedJob) => string
): {
  winner: NormalisedJob;
  strongLosers: NormalisedJob[];
  weakLosers: NormalisedJob[];
} {
  const sorted = [...group].sort((a, b) => scoreJob(b) - scoreJob(a));
  const winner = sorted[0];
  const winCity = winnerCity(winner);

  const strongLosers: NormalisedJob[] = [];
  const weakLosers:   NormalisedJob[] = [];

  for (const j of sorted.slice(1)) {
    if (winnerCity(j) === winCity) strongLosers.push(j);
    else                            weakLosers.push(j);
  }
  return { winner, strongLosers, weakLosers };
}

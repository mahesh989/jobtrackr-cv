// Stage 4b — Keyword pre-filter.
// Keeps only jobs that match at least one of the user's search keywords
// in the title or description. Sets keywords_matched[] on passing jobs.
//
// Title/description exclusion rules have moved to postFetchFilter.ts (stage 4c)
// so they apply universally across all sources.
//
// Matching rules:
//  • Multi-word phrases ("Data Analyst") → exact substring match
//  • Single words ("SQL") → word-boundary match (\b) so "SQL" ≠ "MySQL"

import type { NormalisedJob } from "./types.js";

function buildMatcher(kw: string): (haystack: string) => boolean {
  const lower = kw.toLowerCase().trim();
  const words = lower.split(/\s+/);

  if (words.length === 1) {
    // Single word — word-boundary match so "SQL" doesn't match "MySQL"
    const escaped = lower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b`);
    return (h) => re.test(h);
  }

  // Multi-word phrase — two strategies, either is a match:
  //   1. Exact phrase as substring ("data analyst" in "senior data analyst") ← strictest
  //   2. All words individually present with word boundaries
  //      ("data" AND "analyst" anywhere) ← catches Adzuna results where the
  //      description snippet is too short to contain the full phrase but the
  //      title or description clearly refers to the same role.
  const wordMatchers = words.map((w) => {
    const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`, "i");
  });

  return (h) => h.includes(lower) || wordMatchers.every((re) => re.test(h));
}

export function keywordFilter(
  jobs: NormalisedJob[],
  keywords: string[]
): NormalisedJob[] {
  if (keywords.length === 0) return jobs;

  const matchers = keywords.map((kw) => ({
    kw,
    match: buildMatcher(kw),
  }));

  const results: NormalisedJob[] = [];

  for (const job of jobs) {
    // Search title (weighted ×2 for accuracy of keywords_matched) + description
    const haystack = `${job.title} ${job.title} ${job.description}`.toLowerCase();

    const matched = matchers
      .filter(({ match }) => match(haystack))
      .map(({ kw }) => kw);

    if (matched.length > 0) {
      results.push({ ...job, keywords_matched: matched });
    }
  }

  return results;
}

// Post-fetch smart filter — Stage 4b
//
// Runs AFTER all sources have fetched and jobs are normalised.
// Applies the user's smart filter rules universally across ALL sources,
// not just Adzuna. Adding a new source requires zero filter changes here.
//
// Rule order (cheapest first):
//   1. Title must contain       — user enforces a required word/phrase in title
//   2. Exclude from title       — drop if title matches any exclusion phrase
//   3. Exclude from description — drop if description contains excluded words

import type { NormalisedJob } from "./types.js";
import type { SearchProfile } from "../sources/types.js";

// Build a matcher that respects word boundaries for single words,
// substring for multi-word phrases.
function buildMatcher(phrase: string): (haystack: string) => boolean {
  const lower = phrase.toLowerCase().trim();
  if (!lower) return () => true;
  const words = lower.split(/\s+/);
  if (words.length === 1) {
    const escaped = lower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b`, "i");
    return (h) => re.test(h);
  }
  return (h) => h.toLowerCase().includes(lower);
}

export interface PostFetchFilterResult {
  kept: NormalisedJob[];
  droppedTitleMissing: number;   // didn't contain required phrase
  droppedTitleExcluded: number;  // matched an exclusion
  droppedDescExcluded: number;   // description contained excluded word
}

export function postFetchFilter(
  jobs: NormalisedJob[],
  profile: SearchProfile
): PostFetchFilterResult {
  let kept = jobs;
  let droppedTitleMissing = 0;
  let droppedTitleExcluded = 0;
  let droppedDescExcluded = 0;

  // ── 1. Title must contain ────────────────────────────────────────────────
  // User specifies a word/phrase that MUST appear in the job title.
  // Example: "analyst" → drops "Business Development Manager" etc.
  if (profile.adzuna_title_keywords?.trim()) {
    const required = buildMatcher(profile.adzuna_title_keywords.trim());
    const before = kept.length;
    kept = kept.filter((j) => required(j.title));
    droppedTitleMissing = before - kept.length;
  }

  // ── 2. Exclude from title ────────────────────────────────────────────────
  // Comma-separated list. Drop any job whose title contains any of these.
  // Example: ["senior", "lead", "principal", "business analyst"]
  if (profile.exclude_title_keywords && profile.exclude_title_keywords.length > 0) {
    const exclusionMatchers = profile.exclude_title_keywords
      .map((k) => k.trim())
      .filter(Boolean)
      .map(buildMatcher);

    const before = kept.length;
    kept = kept.filter((j) => {
      return !exclusionMatchers.some((matches) => matches(j.title));
    });
    droppedTitleExcluded = before - kept.length;
  }

  // ── 3. Exclude from description ──────────────────────────────────────────
  const descResult = excludeByDescription(kept, profile);
  kept = descResult.kept;
  droppedDescExcluded = descResult.dropped;

  return { kept, droppedTitleMissing, droppedTitleExcluded, droppedDescExcluded };
}

/**
 * Standalone description-exclusion gate. Used by the orchestrator as a
 * second pass after SEEK JD enrichment, so excluded phrases hiding in the
 * full JD (not the teaser) are still caught.
 *
 * Returns the surviving jobs and a count of how many were dropped.
 */
export function excludeByDescription(
  jobs: NormalisedJob[],
  profile: SearchProfile
): { kept: NormalisedJob[]; dropped: number } {
  if (!profile.adzuna_exclude_keywords?.trim()) {
    return { kept: jobs, dropped: 0 };
  }
  const words = profile.adzuna_exclude_keywords
    .trim()
    .split(/[\s,]+/)
    .map((w) => w.trim())
    .filter(Boolean)
    .map(buildMatcher);

  const before = jobs.length;
  const kept = jobs.filter((j) => {
    const desc = j.description ?? "";
    return !words.some((matches) => matches(desc));
  });
  return { kept, dropped: before - kept.length };
}

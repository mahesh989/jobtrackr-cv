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
  /** Per-phrase attribution of the description exclusions — which excluded
   *  term knocked out how many jobs. Makes "desc excluded: 11" actionable. */
  descExcludedByPhrase: Record<string, number>;
}

export function postFetchFilter(
  jobs: NormalisedJob[],
  profile: SearchProfile
): PostFetchFilterResult {
  let kept = jobs;
  let droppedTitleMissing = 0;
  let droppedTitleExcluded = 0;

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

  return {
    kept,
    droppedTitleMissing,
    droppedTitleExcluded,
    droppedDescExcluded: descResult.dropped,
    descExcludedByPhrase: descResult.byPhrase,
  };
}

/**
 * Standalone description-exclusion gate. Used by the orchestrator as a
 * second pass after SEEK JD enrichment, so excluded phrases hiding in the
 * full JD (not the teaser) are still caught.
 *
 * Returns the surviving jobs, how many were dropped, and a per-phrase
 * attribution (which excluded term matched how many jobs — first match wins).
 */
export function excludeByDescription(
  jobs: NormalisedJob[],
  profile: SearchProfile
): { kept: NormalisedJob[]; dropped: number; byPhrase: Record<string, number> } {
  if (!profile.adzuna_exclude_keywords?.trim()) {
    return { kept: jobs, dropped: 0, byPhrase: {} };
  }
  const matchers = profile.adzuna_exclude_keywords
    .trim()
    .split(/,/)
    .map((w) => w.trim())
    .filter(Boolean)
    .map((phrase) => ({ phrase, match: buildMatcher(phrase) }));

  const byPhrase: Record<string, number> = {};
  const kept = jobs.filter((j) => {
    const desc = j.description ?? "";
    const hit = matchers.find((m) => m.match(desc));
    if (hit) {
      byPhrase[hit.phrase] = (byPhrase[hit.phrase] ?? 0) + 1;
      return false;
    }
    return true;
  });
  return { kept, dropped: jobs.length - kept.length, byPhrase };
}

/** Render a per-phrase breakdown for logs, e.g. "[home care: 8, acute care: 3]".
 *  Returns "" when nothing was dropped so callers can append unconditionally. */
export function formatExcludeBreakdown(byPhrase: Record<string, number>): string {
  const entries = Object.entries(byPhrase).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return "";
  return " [" + entries.map(([p, n]) => `${p}: ${n}`).join(", ") + "]";
}

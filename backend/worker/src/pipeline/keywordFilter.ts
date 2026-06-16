// Stage 4b — Keyword pre-filter.
// Title-only matching is the production default, with optional must-include
// smart filter and teaser rescue. The orchestrator calls
// applyKeywordFilter(jobs, profile).
//
// Matching rules:
//   • Single word ("SQL")          → \bword\b case-insensitive ("SQL" ≠ "MySQL")
//   • Multi-word phrase ("Data Analyst")
//        → exact substring  OR  all words individually present with \b
//
// Three layers:
//   1. titleOnlyFilter   — pass if title contains any phrase
//   2. teaserRescueFilter — for title-rejects, scan first 500 chars of
//                          description for any phrase. Only activates when
//                          must_include_phrases is set (NOT the keyword
//                          fallback) — i.e. the user explicitly opted into
//                          broader semantic acceptance.
//   3. applyKeywordFilter — picks which phrases to use (must_include if set,
//                          else profile.keywords) and orchestrates 1 + 2.

import type { SearchProfile } from "../sources/types.js";
import type { NormalisedJob } from "./types.js";

// ── Matcher builders ─────────────────────────────────────────────────────────

/** Word-boundary matchers for a list of phrases. Used by both filters below. */
export function buildMatchers(phrases: string[]) {
  return phrases.map((kw) => {
    const lower = kw.toLowerCase().trim();
    const words = lower.split(/\s+/);
    if (words.length === 1) {
      const escaped = lower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`\\b${escaped}\\b`, "i");
      return { kw, match: (text: string) => re.test(text) };
    }
    const wordRes = words.map((w) => {
      const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`\\b${escaped}\\b`, "i");
    });
    return {
      kw,
      match: (text: string) =>
        text.toLowerCase().includes(lower) ||
        wordRes.every((re) => re.test(text)),
    };
  });
}

// ── Pass 1: title-only ───────────────────────────────────────────────────────

/**
 * Title-only filter. A job passes if its title contains any of `phrases`
 * under the matching rules above. Matched phrases are written to
 * keywords_matched[] so downstream stages can use them for ranking / display.
 */
export function titleOnlyFilter(
  jobs:    NormalisedJob[],
  phrases: string[],
): NormalisedJob[] {
  if (phrases.length === 0) return jobs;
  const matchers = buildMatchers(phrases);
  const out: NormalisedJob[] = [];
  for (const job of jobs) {
    const title = job.title || "";
    const matched = matchers.filter(({ match }) => match(title)).map((m) => m.kw);
    if (matched.length > 0) out.push({ ...job, keywords_matched: matched });
  }
  return out;
}

// ── Pass 2: teaser rescue ────────────────────────────────────────────────────

const TEASER_CHARS = 500;

/**
 * Teaser rescue. For jobs that FAILED title-only, scan the first 500 chars
 * of the description for any of `phrases`. Recovers legit role variants
 * whose title doesn't carry the exact phrase (e.g. "Business Analyst
 * (Data & Reporting)" rescued by "Data Analyst") without opening up the
 * noise of full-description matching.
 *
 * Caller is expected to pass ONLY title-rejected jobs as `jobs`.
 */
export function teaserRescueFilter(
  jobs:    NormalisedJob[],
  phrases: string[],
): NormalisedJob[] {
  if (phrases.length === 0) return [];
  const matchers = buildMatchers(phrases);
  const out: NormalisedJob[] = [];
  for (const job of jobs) {
    const teaser = (job.description ?? "").slice(0, TEASER_CHARS);
    const matched = matchers.filter(({ match }) => match(teaser)).map((m) => m.kw);
    if (matched.length > 0) out.push({ ...job, keywords_matched: matched });
  }
  return out;
}

// ── Orchestrator entry point ─────────────────────────────────────────────────

/**
 * Production keyword filter. Title-only by default; teaser rescue activates
 * when must_include_phrases is explicitly set on the profile (broader
 * semantic acceptance opted into by the user).
 *
 * Phrase source priority:
 *   profile.must_include_phrases (if non-empty)  ← user's smart filter
 *   profile.keywords (otherwise)                 ← fall-back: filter by search keys
 */
export function applyKeywordFilter(
  jobs:    NormalisedJob[],
  profile: SearchProfile,
): NormalisedJob[] {
  const mustInclude = (profile.must_include_phrases ?? [])
    .filter((s) => typeof s === "string" && s.trim().length > 0);
  const usingSmartFilter = mustInclude.length > 0;
  const phrases = usingSmartFilter ? mustInclude : profile.keywords;

  if (phrases.length === 0) return jobs;

  const titlePassed = titleOnlyFilter(jobs, phrases);

  if (!usingSmartFilter) return titlePassed; // no rescue without explicit must-include

  // Teaser rescue on the title rejects.
  const passedHashes = new Set(titlePassed.map((j) => j.url_hash));
  const titleRejected = jobs.filter((j) => !passedHashes.has(j.url_hash));
  const rescued = teaserRescueFilter(titleRejected, mustInclude);

  return [...titlePassed, ...rescued];
}


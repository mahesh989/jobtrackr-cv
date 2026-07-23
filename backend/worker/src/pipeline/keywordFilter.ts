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

// ── Orchestrator entry point ─────────────────────────────────────────────────

/**
 * Production keyword filter — TITLE ONLY.
 *
 * Honors the UI contract: "Title must include any of …" means the phrase must
 * appear in the job TITLE. We do NOT scan the description. (Previously a
 * "teaser rescue" pass also matched the first 500 chars of the description,
 * which silently admitted off-target roles — e.g. a "Disability Support Worker"
 * or "Registered Nurse" whose JD merely mentioned "AIN"/"care worker". That
 * contradicted the field's label and is removed.)
 *
 * Phrase source priority:
 *   profile.must_include_phrases (if non-empty)  ← user's title filter
 *   profile.keywords (otherwise)                 ← fall-back: filter by search keys
 */
export function applyKeywordFilter(
  jobs:    NormalisedJob[],
  profile: SearchProfile,
): NormalisedJob[] {
  const mustInclude = (profile.must_include_phrases ?? [])
    .filter((s) => typeof s === "string" && s.trim().length > 0);
  const phrases = mustInclude.length > 0 ? mustInclude : profile.keywords;

  if (phrases.length === 0) return jobs;

  return titleOnlyFilter(jobs, phrases);
}


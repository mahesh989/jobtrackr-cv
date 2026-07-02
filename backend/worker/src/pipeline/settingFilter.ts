// Per-profile work-setting filter — the final gate before a job is saved to a
// profile's `jobs` table (and therefore before Full Analysis can ever see it).
//
// Setting CLASSIFICATION (the label) is a shared, once-per-job fact computed by
// ai/settingClassifier.ts and stored on global_jobs. This module is the OTHER
// half: the per-profile decision to keep or drop based on the user's opt-in
// `setting_filter` selection. It runs at serve time (bucket path) and in the
// legacy scrape path — the SAME helper in both so they can never diverge.
//
// Fail-open policy (deliberate — a missed job the user wanted is worse than a
// stray job they didn't): only DROP a job when it has a CONFIDENT category that
// the user did not select. Everything uncertain is surfaced (flagged in the UI):
//   - setting_filter empty            → no filtering at all (opt-in)
//   - setting_category null           → not a care job / unclassified → keep
//   - setting_category 'other'        → indeterminate safety bucket → keep
//   - setting_confidence < threshold  → too unsure to drop → keep
//   - setting_category ∈ selection    → match → keep
//   - otherwise (confident, unwanted) → DROP

import type { NormalisedJob } from "./types.js";
import type { SearchProfile } from "../sources/types.js";

// Below this confidence we never drop — the classifier isn't sure enough.
export const SETTING_DROP_CONFIDENCE = 0.7;

export interface SettingFilterResult {
  kept: NormalisedJob[];
  dropped: number;
  /** Per-category attribution of what was dropped, for actionable logs. */
  byCategory: Record<string, number>;
}

export function applySettingFilter(
  jobs: NormalisedJob[],
  profile: SearchProfile,
): SettingFilterResult {
  const selection = profile.setting_filter ?? [];
  if (selection.length === 0) {
    return { kept: jobs, dropped: 0, byCategory: {} };
  }

  const byCategory: Record<string, number> = {};
  const kept = jobs.filter((j) => {
    const cat = j.setting_category;
    // Fail-open cases — always keep.
    if (cat === null || cat === undefined) return true;
    if (cat === "other") return true;
    if (selection.includes(cat)) return true;
    const conf = j.setting_confidence ?? 0;
    if (conf < SETTING_DROP_CONFIDENCE) return true;
    // Confident, unwanted category → drop.
    byCategory[cat] = (byCategory[cat] ?? 0) + 1;
    return false;
  });

  return { kept, dropped: jobs.length - kept.length, byCategory };
}

/** Render a per-category breakdown for logs, e.g. "[home_community: 12]".
 *  Returns "" when nothing was dropped so callers can append unconditionally. */
export function formatSettingBreakdown(byCategory: Record<string, number>): string {
  const entries = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return "";
  return " [" + entries.map(([c, n]) => `${c}: ${n}`).join(", ") + "]";
}

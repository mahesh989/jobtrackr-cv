import { db } from "../../db/client.js";
import type { FullProfile } from "./types.js";

export async function loadProfile(profileId: string): Promise<FullProfile | null> {
  const { data } = await db
    .from("search_profiles")
    .select("id, name, user_id, is_manual, keywords, location, visa_filter_mode, target_verticals, setting_filter, adzuna_title_keywords, adzuna_exact_phrase, adzuna_any_keywords, adzuna_exclude_keywords, adzuna_salary_min, adzuna_salary_max, adzuna_distance_km, adzuna_max_days_old, exclude_title_keywords, must_include_phrases, automation_enabled, enabled_sources, seek_method, adzuna_method, home_address, home_lat, home_lng")
    .eq("id", profileId)
    .single();
  return data as FullProfile | null;
}

// Canonical work-type tags (mirrors lib/constants.ts ALL_EMPLOYMENT_TYPES on
// the web side + jdFacts.ts EmploymentType here) — validated so a stale
// client value can't leak into the filter. Also accepts the 3 legacy
// Title-Case values written before Fix 3.
const WORK_TYPE_TAGS = new Set(["full_time", "part_time", "casual", "contract", "temporary", "internship"]);
const LEGACY_WORK_TYPE: Record<string, string> = {
  "Full Time": "full_time", "Part Time": "part_time", "Casual": "casual",
};
export function normalizeWorkTypes(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<string>();
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const tag = LEGACY_WORK_TYPE[v] ?? v;
    if (WORK_TYPE_TAGS.has(tag)) out.add(tag);
  }
  return [...out];
}

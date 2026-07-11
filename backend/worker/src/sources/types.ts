// SourceAdapter interface — every source plugin must implement this.
// Adding a new source = write one adapter, zero changes to pipeline core.

export interface SearchProfile {
  id: string;
  keywords: string[];
  location: string;
  visa_filter_mode: string;
  working_rights?: "any" | "pr_citizen" | "needs_sponsorship";
  target_verticals?: string[];
  // Work-setting filter (Migration 078). Category keys the user wants to keep:
  // 'hospital_clinical' | 'residential_aged_care' | 'home_community' | 'other'.
  // Empty/undefined = no filtering (opt-in). See pipeline/settingFilter.ts.
  setting_filter?: string[];
  // Employment-type filter (Migration 080). Canonical tags to keep
  // (full_time/part_time/casual/contract/temporary/internship); a job passes
  // when its employment_types intersect, or when it has none extracted
  // (never hide jobs we couldn't classify). Empty/undefined = no filtering.
  employment_filter?: string[];
  // User-level visa status resolved from user_preferences.contact_details
  // (set by the orchestrator per run, not a search_profiles column):
  // citizen | pr | temp_unrestricted | student_capped | needs_sponsorship.
  // Drives the stage-10b eligibility filter; undefined = legacy behaviour.
  user_visa_status?: string;
  adzuna_title_keywords?: string;
  adzuna_exact_phrase?: string;
  adzuna_any_keywords?: string;
  adzuna_exclude_keywords?: string;
  adzuna_salary_min?: number;
  adzuna_salary_max?: number;
  adzuna_contract_type?: string;
  adzuna_hours?: string;
  adzuna_distance_km?: number;
  adzuna_max_days_old?: number;
  exclude_title_keywords?: string[];
  // Optional "smart filter — must include any of" (promoted from beta).
  // A job passes the keyword filter if its TITLE contains any of these
  // phrases. Empty/undefined → fall back to filtering by `keywords` above.
  // When non-empty, also activates teaser rescue (first 500 chars of
  // description scanned for title-rejects).
  must_include_phrases?: string[];
  is_manual_run?: boolean;

  // Set by the orchestrator per run, read by date-aware adapters (Adzuna, SEEK,
  // Careerjet) to fetch deep on the first run then do incremental top-ups:
  //   is_first_run  — no prior completed run for this profile → fetch deeper.
  //   lookback_days — days to look back this run (28 on first run, else
  //                   days-since-last-run + 1, capped 30).
  is_first_run?: boolean;
  lookback_days?: number;

  // Per-profile source selection (Migration 041).
  //   enabled_sources — adapter names to run; null/empty = all active sources.
  //   seek_method      — 'direct' (free curl_cffi) or 'actor' (Apify, paid).
  enabled_sources?: string[] | null;
  seek_method?: "direct" | "actor";

  // Per-profile Adzuna fetch strategy (Migration 047).
  //   'api'    → API teasers only (~600 char descriptions). Fast, default.
  //   'direct' → also scrape /details/<id> HTML for full ~8k char JDs.
  //              Slower, opt-in. Worker is background so user UI is unaffected.
  adzuna_method?: "api" | "direct";
}

export interface RawJob {
  url: string;
  title: string;
  company: string;
  location: string;
  description: string;
  source: string;         // adapter name: "adzuna" | "greenhouse" | etc.
  source_tier: 1 | 2 | 3 | 4 | 5;
  posted_at: string | null;
  expires_at: string | null;
  salary_min?: number;
  salary_max?: number;
  // Source-provided work-type strings, verbatim (SEEK workTypes, Adzuna
  // contract_time/contract_type, ATS employmentType, …). Mapped to canonical
  // employment_types tags in normalise — structured beats regex.
  employment_types_raw?: string[];
  raw?: unknown;          // original adapter response, for debugging
}

export interface SourceAdapter {
  name: string;
  tier: 1 | 2 | 3 | 4 | 5;
  vertical: "tech" | "healthcare" | "general";
  rateLimitDelay: number; // ms to wait between consecutive calls
  fetchJobs(profile: SearchProfile): Promise<RawJob[]>;
  isHealthy(): Promise<boolean>;
}

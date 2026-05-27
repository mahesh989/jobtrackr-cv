// SourceAdapter interface — every source plugin must implement this.
// Adding a new source = write one adapter, zero changes to pipeline core.

export interface SearchProfile {
  id: string;
  keywords: string[];
  location: string;
  visa_filter_mode: string;
  working_rights?: "any" | "pr_citizen" | "needs_sponsorship";
  target_verticals?: string[];
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

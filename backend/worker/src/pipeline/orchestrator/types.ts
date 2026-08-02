import type { SearchProfile } from "../../sources/types.js";

export interface FullProfile extends SearchProfile {
  user_id: string;
  // Engagement notifications (migration 079) — used for pending_job_notifications.profile_name.
  name: string;
  // Auto-created "Saved Jobs" container for manually-added jobs. Never a real
  // search — has no keywords/location by design.
  is_manual: boolean;
  // Phase A automation config. min_initial_ats / min_final_ats were dropped
  // from search_profiles in migration 041 — global constants now (60 / 70)
  // enforced by cv-backend AnalyzeRequest defaults.
  automation_enabled:      boolean;
  // Migration 048 — distance origin. home_address is what the user typed.
  // home_lat/home_lng are filled lazily on the next run after the address
  // changes (the actions layer resets them to null on edit).
  home_address: string | null;
  home_lat:     number | null;
  home_lng:     number | null;
}

// ── Integration types ──────────────────────────────────────────────────────────
export interface UserIntegration {
  id:                  string;
  encrypted_api_key:   string;
  status:              string;
  quota_used_usd:      number;
  quota_used_requests: number;
  quota_period_start:  string;  // date as ISO string "YYYY-MM-DD"
  is_enabled:          boolean;
  config:              Record<string, unknown>;
}

/**
 * Per-run source method tracking, persisted to run_logs.source_methods.
 *
 * ⚠ CROSS-SERVICE DATA CONTRACT. The admin Sourcing page
 * (frontend/web/src/app/(dashboard)/admin/sourcing/page.tsx) reads these KEYS
 * and compares their STRING VALUES ("direct", "apify", "apify_fallback",
 * "apify_failed", "teaser", "actor", "actor_failed_teaser", "direct_curl", …)
 * straight out of untyped JSONB. Renaming a key or changing a literal silently
 * turns that dashboard into zeroes - no type error, no runtime error.
 */
export type SourceMethods = {
  tier: string;
  seek?:      { enabled: boolean; listings?: string; jd?: string; merged?: number; fetched?: number; count?: number };
  adzuna?:    { enabled: boolean; method?: string; enrichment?: string; merged?: number; fetched?: number };
  careerjet?: { enabled: boolean; method?: string };
};

export type SubscriptionTier = "weekly" | "monthly" | "unlimited";

export interface PlatformSources {
  tier:            SubscriptionTier;
  enabled_sources: string[];
  adzuna_method:   "api" | "direct";
  seek_method:     "direct" | "actor";
}

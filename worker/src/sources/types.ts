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
  is_manual_run?: boolean;
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

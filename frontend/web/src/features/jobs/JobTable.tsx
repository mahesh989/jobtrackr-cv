/**
 * Job — the base row shape for a job-board entry.
 *
 * The rendering component that used to live in this file (a 12-col grid
 * table: Role · Company · Source · Posted · Added · Progress · Visa ·
 * Actions) was removed: it was entirely unreachable — SmartFeed.tsx's
 * card-based UI superseded it, and nothing outside this file imported
 * anything from here except this type (via jobFilters.ts's `BoardJob =
 * Job & {...}`). Kept in this file rather than moved, since jobFilters.ts
 * and everything downstream of it already imports Job from here.
 */

import type { JobProgress } from "./progressFlags";
import type { PipelineState } from "./pipelineState";

export interface Job {
  id:                  string;
  profile_id:          string;
  url:                 string;
  title:               string;
  company:             string;
  location:            string;
  description:         string;
  source:              string;
  source_tier:         number;
  posted_at:           string | null;
  created_at:          string;
  salary_min?:         number;
  salary_max?:         number;
  visa_likelihood:     number | null;
  sponsorship_status:  "yes" | "no" | "not_mentioned" | null;
  citizen_pr_only:     boolean | null;
  visa_extracted_text: string | null;
  // Work-setting classification (Migration 078). Null category = not a care job
  // / unclassified — no chip shown.
  setting_category?:   "hospital_clinical" | "residential_aged_care" | "home_community" | "other" | null;
  setting_confidence?: number | null;
  setting_evidence?:   string | null;
  // JD facts (Migration 080) — extracted at scrape time by the worker.
  // All optional/null-tolerant: rows scraped before the migration carry nulls.
  employment_types?:        string[] | null;
  work_rights_requirement?: string | null;
  extracted_emails?:        Array<{ email: string; kind: string; person: string | null; context: string }> | null;
  salary_period?:           "hour" | "day" | "week" | "fortnight" | "year" | null;
  closing_date?:            string | null;
  shift_patterns?:          string[] | null;
  is_agency?:               boolean | null;
  keywords_matched:    string[];
  applied_at:          string | null;
  dismissed_at:        string | null;
  starred_at?:         string | null;
  is_dead_link:        boolean;
  seen_at:             string | null;
  dedup_status?:       string | null;
  manual_jd_text?:     string | null;
  contact_email?:      string | null;
  hiring_manager?:     string | null;
  company_address?:    string | null;
  /** Set on the unified dashboard board (all profiles) — undefined on
   * per-profile boards where the profile context is already obvious. */
  profile_name?:       string | null;
  // Phase A signals (backfilled for existing jobs, set during scraping
  // for new jobs once Phase C lands).
  jd_quality?:         "rich" | "thin" | "unknown" | null;
  role_match?:         "match" | "mismatch" | "uncertain" | null;
  has_email?:          boolean | null;
  /** Driving distance from the profile's home_address. Null when no
   *  home_address is set, or the job location couldn't be geocoded. */
  distance_km?:        number | null;
  /** 'driving' = OSRM route; 'haversine' = straight-line fallback (UI
   *  renders ~ prefix and a tooltip explaining the approximation). */
  distance_method?:    "driving" | "haversine" | null;
  /** ATS scores from the latest analysis run (null when not yet analysed). */
  initial_ats_score?:   number | null;
  tailored_match_score?: number | null;
  /** Derived in page.tsx from (work_rights_requirement × the user's My CV
   *  visa status) via lib/eligibility.computeEligibility. Null when the user
   *  hasn't declared a visa status. */
  eligibility?:        "eligible" | "not_eligible" | "unclear" | null;
  /** Derived in page.tsx: capped student × exclusively full-time job. */
  hours_cap_conflict?: boolean;
  /** Derived in page.tsx via progressFlags.deriveProgress(). */
  progress:            JobProgress;
  /** Derived in page.tsx via pipelineState.derivePipelineState(). */
  pipelineState?:      PipelineState;
}

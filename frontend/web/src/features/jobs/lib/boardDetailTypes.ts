/**
 * Shared TS shapes for the job-board detail pane (master-detail redesign).
 *
 * These mirror the JSON blobs already stored on `analysis_runs` — the same
 * shapes `features/cv/analysis/*Card.tsx` parse for the full analysis page —
 * but declared locally since those files keep their interfaces private.
 * Kept intentionally loose (all-optional) because AI-authored JSON varies
 * run-to-run; every consumer must handle missing fields.
 */

import type { CategorisedSkills, SkillCategory } from "@/lib/types";

export interface JobContext {
  setting?:  string | null;
  settings?: string[];
}

export interface Credentials {
  required?:    string[];
  preferred?:   string[];
  eligibility?: string[];
}

export interface JDAnalysisData {
  job_title?:                 string;
  seniority_level?:           string;
  summary?:                   string;
  required_skills?:           CategorisedSkills | string[];
  preferred_skills?:          CategorisedSkills | string[];
  responsibilities?:          string[];
  experience_years_required?: number | null;
  category_labels?:           Record<string, string>;
  category_order?:            string[];
  credentials?:               Credentials;
  job_context?:               JobContext;
}

export interface CatCount        { matched: number; total: number }
export interface BucketCounts    { technical?: CatCount; soft_skills?: CatCount; domain_knowledge?: CatCount }
export interface MatchingCounts  { required?: BucketCounts; preferred?: BucketCounts; overall?: CatCount }
export interface CategorisedKeywords { technical?: string[]; soft_skills?: string[]; domain_knowledge?: string[] }
export interface BucketKeywords  { required?: CategorisedKeywords; preferred?: CategorisedKeywords }
export interface MatchRates {
  technical_pct?: number; soft_skills_pct?: number; domain_knowledge_pct?: number;
  required_pct?:  number; preferred_pct?:   number; overall_pct?:          number;
}
export interface CredentialsGap {
  required?: string[]; preferred?: string[]; eligibility?: string[];
  present?:  string[]; missing?:   string[];
}
export interface MatchingData {
  matched?:               BucketKeywords;
  missed?:                BucketKeywords;
  counts?:                MatchingCounts;
  match_rates?:           MatchRates;
  credentials_required?:  CredentialsGap;
  matched_skills?:        string[];
  missing_skills?:        string[];
  match_summary?:         string;
}

export interface AtsScoringData {
  overall_score?:            number;
  keyword_match_score?:      number;
  experience_match_score?:   number;
  formatting_score?:         number;
  strengths?:                string[];
  weaknesses?:               string[];
}

export interface FeasibilityEntryBase {
  keyword?:  string;
  category?: string;
  bucket?:   "required" | "preferred";
  evidence?: string;
  rationale?: string;
}
export interface InjectExtensionEntry extends FeasibilityEntryBase { suggested_rewrite?: string }
export interface InjectInferenceEntry extends FeasibilityEntryBase {
  confidence?:      "low" | "medium" | "high";
  inferred_from?:   string[];
  inference_chain?: string;
  suggested_rewrite?: string;
}
export interface CannotInjectEntry extends FeasibilityEntryBase { reason?: string }

export interface FeasibilityPlan {
  inject_directly?:      FeasibilityEntryBase[];
  inject_as_extension?:  InjectExtensionEntry[];
  inject_with_inference?: InjectInferenceEntry[];
  cannot_inject?:        CannotInjectEntry[];
}
export interface FeasibilitySummary {
  n_inject_directly?:      number;
  n_inject_as_extension?:  number;
  n_inject_with_inference?: number;
  n_cannot_inject?:        number;
  honest_gaps?:            string[];
  expected_lift_pts?:      number;
}
export interface KeywordFeasibility {
  feasibility_plan?: FeasibilityPlan;
  summary?:          FeasibilitySummary;
}

export interface QualityFlags {
  honesty_risk?: { risk_level?: string; initial_ats?: number; vertical_months?: number };
  honesty_guard_notes?:      string[];
  pre_filter_dropped_roles?: string[];
}

export interface StructuralReportSummary { pass?: number; warn?: number; fail?: number; total?: number }
export interface TailoredAtsScoringResult { structural_report?: { summary?: StructuralReportSummary } }

export interface InjectedKeywords {
  injected?:              string[];
  failed_to_inject?:      string[];
  filtered_as_non_skill?: string[];
  honest_gaps?:           string[];
  fabricated?:            string[];
}

/** The `run` object returned by GET /api/jobs/[id]/board-detail. */
export interface BoardDetailRun {
  id:                    string;
  status:                string;
  step_status:           Record<string, string> | null;
  cover_letter_status:   string | null;
  error_message:         string | null;
  jd_analysis_result:            JDAnalysisData | null;
  cv_jd_matching_result:         MatchingData | null;
  ats_scoring_result:            AtsScoringData | null;
  keyword_feasibility:           KeywordFeasibility | null;
  tailored_ats_scoring_result:   TailoredAtsScoringResult | null;
  injected_keywords:             InjectedKeywords | null;
  quality_flags:                 QualityFlags | null;
  match_score:           number | null;
  tailored_match_score:  number | null;
  ats_lift:              number | null;
  tailored_cv_storage_path: string | null;
  ai_provider:           string | null;
  ai_model:              string | null;
  created_at:            string;
}

export interface BoardDetailCoverLetter {
  id:            string;
  status:        string | null;
  pass_3_final:  string | null;
  tone_target:   string | null;
  email_body:    string | null;
  email_subject: string | null;
  /** Set once the application email has gone out. Every edit route
   *  (PATCH the letter, POST /review, GET /email-draft) 409s from this point
   *  on, so the Cover letter tab renders read-only rather than mounting
   *  editors that can only fail. */
  email_sent_at: string | null;
}

export interface BoardDetailPayload {
  run:          BoardDetailRun | null;
  cover_letter: BoardDetailCoverLetter | null;
  /** Raw scraped JD. Fetched per-job here instead of on every board row —
   *  see the note in the board-detail route. Null until the fetch resolves. */
  description:    string | null;
  manual_jd_text: string | null;
  /** Fresh copies of the board list's own `jd_quality`/`role_match` — see the
   *  note in the board-detail route on why the pane's pipelineState recompute
   *  must use these instead of the job prop. */
  jd_quality: string | null;
  role_match: string | null;
}

export const CAT_ORDER: readonly SkillCategory[] = ["domain_knowledge", "soft_skills", "technical"];

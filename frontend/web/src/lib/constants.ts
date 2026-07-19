/**
 * Shared constants — single source of truth for string enums used across components.
 *
 * Uses `as const` objects (idiomatic TS, not enums) so values are
 * directly comparable to strings and usable as union types.
 *
 * SkillCategory lives in @/lib/types — it's a domain type, not a constant.
 */

export const RunStatus = {
  PENDING: "pending",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
} as const;

export type RunStatus = (typeof RunStatus)[keyof typeof RunStatus];

export const StepState = {
  ...RunStatus,
  SKIPPED: "skipped",
} as const;

export type StepState = (typeof StepState)[keyof typeof StepState];

export const ADMIN_ROLES = ["founder", "admin"] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

export const VisaStatus = {
  AU_CITIZEN: "au_citizen",
  PR: "pr",
  WORKING_HOLIDAY: "working_holiday",
  STUDENT_VISA: "student_visa",
  TEMPORARY_WORK: "temp_work",
  OTHER: "other",
} as const;

export type VisaStatus = (typeof VisaStatus)[keyof typeof VisaStatus];

// Mirrors backend/worker/src/ai/jdFacts.ts (EmploymentType / ALL_EMPLOYMENT_TYPES) —
// keep the two in sync, same mirror discipline as lib/eligibility.ts.
export const EmploymentType = {
  FULL_TIME: "full_time",
  PART_TIME: "part_time",
  CASUAL: "casual",
  CONTRACT: "contract",
  TEMPORARY: "temporary",
  INTERNSHIP: "internship",
} as const;

export type EmploymentType = (typeof EmploymentType)[keyof typeof EmploymentType];

export const ALL_EMPLOYMENT_TYPES = [
  "full_time",
  "part_time",
  "casual",
  "contract",
  "temporary",
  "internship",
] as const;

export const EMPLOYMENT_TYPE_LABELS: Record<string, string> = {
  full_time: "Full-time",
  part_time: "Part-time",
  casual: "Casual",
  contract: "Contract",
  temporary: "Temp",
  internship: "Intern",
};

export const JOB_SOURCES = [
  "adzuna", "seek", "careerjet", "greenhouse", "lever",
  "agedcare", "radancy", "avature", "agedcare_dayforce", "successfactors", "adlogic",
] as const;

export type JobSource = (typeof JOB_SOURCES)[number];

export type SourceTier = "weekly" | "monthly" | "unlimited";

export type AdzunaMethod = "api" | "direct";
export type SeekMethod = "direct" | "actor";

export interface TierConfig {
  enabled_sources: string[];
  adzuna_method: AdzunaMethod;
  seek_method: SeekMethod;
}

export const TIER_DEFAULTS: Record<SourceTier, TierConfig> = {
  weekly:    { enabled_sources: ["adzuna", "seek", "careerjet"], adzuna_method: "api",    seek_method: "direct" },
  monthly:   { enabled_sources: ["adzuna", "seek", "careerjet"], adzuna_method: "api",    seek_method: "direct" },
  unlimited: { enabled_sources: ["adzuna", "seek", "careerjet"], adzuna_method: "direct", seek_method: "direct" },
};

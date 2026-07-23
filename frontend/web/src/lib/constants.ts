/**
 * Shared constants — single source of truth for string enums used across components.
 *
 * Uses `as const` objects (idiomatic TS, not enums) so values are
 * directly comparable to strings and usable as union types.
 *
 * SkillCategory lives in @/lib/types — it's a domain type, not a constant.
 */

// analysis_runs.status / run_logs-style lifecycle (no 'skipped' — that's a
// per-step state only).
export const RunStatus = {
  PENDING: "pending",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
} as const;
export type RunStatus = (typeof RunStatus)[keyof typeof RunStatus];

export const StepState = {
  PENDING: "pending",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  SKIPPED: "skipped",
} as const;

export type StepState = (typeof StepState)[keyof typeof StepState];

export const ADMIN_ROLES = ["founder", "admin"] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

// Mirrors backend/worker/src/ai/jdFacts.ts (EmploymentType / ALL_EMPLOYMENT_TYPES) —
// keep the two in sync, same mirror discipline as lib/eligibility.ts.
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

// Legacy Title-Case work-type values (pre-Fix-3 clients stored "Full Time"
// etc.) → canonical snake_case tags. Single source of truth — used by the
// board filter, the Availability form, and the preferences API.
export const LEGACY_WORK_TYPE_MAP: Record<string, string> = {
  "Full Time": "full_time",
  "Part Time": "part_time",
  "Casual":    "casual",
};

export function normalizeWorkType(v: string): string {
  return LEGACY_WORK_TYPE_MAP[v] ?? v;
}

// jobs.jd_quality — DB CHECK-constrained vocabulary (classify_jd_quality()).
export const JdQuality = {
  RICH: "rich",
  THIN: "thin",
  UNKNOWN: "unknown",
} as const;
export type JdQuality = (typeof JdQuality)[keyof typeof JdQuality];

// jobs.role_match — DB CHECK-constrained vocabulary.
export const RoleMatch = {
  MATCH: "match",
  MISMATCH: "mismatch",
  UNCERTAIN: "uncertain",
} as const;
export type RoleMatch = (typeof RoleMatch)[keyof typeof RoleMatch];

// cover_letters.status — DB CHECK vocabulary (025 + Phase-11 'picking').
export const LetterStatus = {
  PENDING: "pending",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  PICKING: "picking",
} as const;
export type LetterStatus = (typeof LetterStatus)[keyof typeof LetterStatus];

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

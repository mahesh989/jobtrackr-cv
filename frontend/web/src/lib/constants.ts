/**
 * Shared constants — single source of truth for string enums used across components.
 *
 * Uses `as const` objects (idiomatic TS, not enums) so values are
 * directly comparable to strings and usable as union types.
 */

export const SkillCategory = {
  TECHNICAL: "technical",
  SOFT_SKILLS: "soft_skills",
  DOMAIN_KNOWLEDGE: "domain_knowledge",
} as const;

export type SkillCategory = (typeof SkillCategory)[keyof typeof SkillCategory];

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

export const Eligibility = {
  ELIGIBLE: "eligible",
  NOT_ELIGIBLE: "not_eligible",
  SPONSORSHIP_REQUIRED: "sponsorship_required",
  UNKNOWN: "unknown",
} as const;

export type Eligibility = (typeof Eligibility)[keyof typeof Eligibility];

export const EmploymentType = {
  FULL_TIME: "full_time",
  PART_TIME: "part_time",
  CONTRACT: "contract",
  CASUAL: "casual",
  TEMPORARY: "temporary",
} as const;

export type EmploymentType = (typeof EmploymentType)[keyof typeof EmploymentType];

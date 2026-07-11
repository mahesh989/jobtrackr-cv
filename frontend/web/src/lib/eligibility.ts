// Eligibility matrix — MIRROR of backend/worker/src/pipeline/eligibility.ts.
// Keep the two in sync: the worker uses it to hard-drop not_eligible jobs at
// fetch; this copy computes the card badge for rows already on the board
// (including pre-080 rows the fetch filter never saw).

export type UserVisaStatus =
  | "citizen"
  | "pr"
  | "temp_unrestricted"
  | "student_capped"
  | "needs_sponsorship";

export type Eligibility = "eligible" | "not_eligible" | "unclear";

const CAPABILITY: Record<UserVisaStatus, number> = {
  citizen: 4,
  pr: 3,
  temp_unrestricted: 2,
  student_capped: 1,
  needs_sponsorship: 0,
};

const DEMAND: Record<string, number> = {
  citizen_only: 4,
  pr_citizen: 3,
  full_unrestricted: 2,
  any_valid: 1,
  not_stated: 0,
};

export const VISA_STATUS_LABELS: Record<UserVisaStatus, string> = {
  citizen: "Australian citizen",
  pr: "Permanent resident",
  temp_unrestricted: "Temporary visa — unrestricted work rights (485, partner, 482…)",
  student_capped: "Student visa — capped hours",
  needs_sponsorship: "Overseas — need visa sponsorship",
};

export const REQUIREMENT_LABELS: Record<string, string> = {
  citizen_only: "Citizens only",
  pr_citizen: "PR/Citizen only",
  full_unrestricted: "Unrestricted work rights required",
  any_valid: "Work rights required",
};

export function isUserVisaStatus(v: unknown): v is UserVisaStatus {
  return typeof v === "string" && v in CAPABILITY;
}

export function computeEligibility(
  job: {
    work_rights_requirement?: string | null;
    sponsorship_status?: string | null;
    citizen_pr_only?: boolean | null;
  },
  status: UserVisaStatus
): Eligibility {
  const requirement =
    job.work_rights_requirement && job.work_rights_requirement in DEMAND
      ? job.work_rights_requirement
      : job.citizen_pr_only === true
        ? "pr_citizen"
        : "not_stated";

  const capability = CAPABILITY[status];
  const demand = DEMAND[requirement];

  if (status === "needs_sponsorship") {
    if (job.sponsorship_status === "yes") return "eligible";
    if (job.sponsorship_status === "no" || demand > 0) return "not_eligible";
    return "unclear";
  }

  return capability >= demand ? "eligible" : "not_eligible";
}

/** Soft warning: capped student vs an exclusively full-time job. */
export function hoursCapConflict(
  job: { employment_types?: string[] | null },
  status: UserVisaStatus
): boolean {
  if (status !== "student_capped") return false;
  const types = job.employment_types ?? [];
  return types.length > 0 && types.every((t) => t === "full_time");
}

export const EMPLOYMENT_LABELS: Record<string, string> = {
  full_time: "Full-time",
  part_time: "Part-time",
  casual: "Casual",
  contract: "Contract",
  temporary: "Temp",
  internship: "Internship",
};

// Eligibility matrix — (job's work-rights requirement × user's visa status)
// → eligible | not_eligible | unclear. Used by the stage-10b fetch filter
// (hard-drop not_eligible when the user has declared a visa status) and
// mirrored in frontend/web/src/lib/eligibility.ts for the job-card badge.
//
// The job side comes from visaExtractor (work_rights_requirement +
// sponsorship_status); the user side from user_preferences.contact_details
// .visa_status — a user-level fact like role_families, NOT per-profile.

export type UserVisaStatus =
  | "citizen"            // Australian citizen
  | "pr"                 // permanent resident
  | "temp_unrestricted"  // 485 / partner / 482 etc — full rights, temporary
  | "student_capped"     // student visa, capped fortnightly hours
  | "needs_sponsorship"; // no current AU work rights (offshore)

export type Eligibility = "eligible" | "not_eligible" | "unclear";

// Higher = holds more. A requirement is met when capability ≥ demand.
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
  // Legacy rows (pre-080) carry only citizen_pr_only — map it to the
  // equivalent requirement so old bucket rows still filter correctly.
  const requirement =
    job.work_rights_requirement && job.work_rights_requirement in DEMAND
      ? job.work_rights_requirement
      : job.citizen_pr_only === true
        ? "pr_citizen"
        : "not_stated";

  const capability = CAPABILITY[status];
  const demand = DEMAND[requirement];

  // Offshore candidates hold nothing today — sponsorship is the whole question.
  if (status === "needs_sponsorship") {
    if (job.sponsorship_status === "yes") return "eligible";
    if (job.sponsorship_status === "no" || demand > 0) return "not_eligible";
    return "unclear";
  }

  if (capability >= demand) {
    // Meets the stated demand. A student meeting only "not_stated" is still
    // just "eligible" — the hours-cap conflict with full-time-only jobs is a
    // soft UI warning (see hoursCapConflict), never a silent drop.
    return "eligible";
  }
  return "not_eligible";
}

/**
 * Soft warning: a capped student looking at a job that is exclusively
 * full-time. Not part of eligibility — students do still apply to some.
 */
export function hoursCapConflict(
  job: { employment_types?: string[] | null },
  status: UserVisaStatus
): boolean {
  if (status !== "student_capped") return false;
  const types = job.employment_types ?? [];
  return types.length > 0 && types.every((t) => t === "full_time");
}

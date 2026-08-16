/**
 * Regression tests for B5-P2 (audit): eligibility.ts:36-38 (worker) /
 * eligibility.ts:40-42 (this web mirror) used `v in CAPABILITY`, which walks
 * the prototype chain — "toString" in CAPABILITY is true even though
 * CAPABILITY has no OWN "toString" key. POST {"visa_status":"toString"} to
 * /api/user/visa-status passed isUserVisaStatus's guard, and
 * computeEligibility("toString") then silently collapsed to not_eligible
 * for EVERY job (CAPABILITY["toString"] resolves to
 * Function.prototype.toString, not a number — every `capability >= demand`
 * comparison becomes a NaN comparison, always false) — the board emptied
 * while the run still reported completed.
 */
import { describe, it, expect } from "vitest";
import { computeEligibility, isUserVisaStatus, hoursCapConflict } from "./eligibility";

/**
 * General decision-matrix coverage, ported from the worker mirror's
 * eligibility.test.ts (backend/worker/src/pipeline/eligibility.ts) — this
 * web copy previously had ONLY the B5-P2 prototype-poisoning regression
 * tests below, with zero coverage of the actual citizen/PR/temp/student/
 * offshore eligibility matrix computeEligibility implements. Both files'
 * shared logic is character-identical (verified during C41d); this closes
 * the coverage gap on the web side so a future edit to one file without the
 * other is caught by whichever side's tests happen to run, not just the
 * worker's.
 */
describe("computeEligibility", () => {
  it("citizen passes everything, including clearance roles", () => {
    expect(computeEligibility({ work_rights_requirement: "citizen_only" }, "citizen")).toBe("eligible");
    expect(computeEligibility({ work_rights_requirement: "not_stated" }, "citizen")).toBe("eligible");
  });

  it("PR is blocked from citizen-only but passes pr_citizen", () => {
    expect(computeEligibility({ work_rights_requirement: "citizen_only" }, "pr")).toBe("not_eligible");
    expect(computeEligibility({ work_rights_requirement: "pr_citizen" }, "pr")).toBe("eligible");
  });

  it("temp-unrestricted (485/partner) passes full_unrestricted but not PR-only", () => {
    expect(computeEligibility({ work_rights_requirement: "full_unrestricted" }, "temp_unrestricted")).toBe("eligible");
    expect(computeEligibility({ work_rights_requirement: "pr_citizen" }, "temp_unrestricted")).toBe("not_eligible");
  });

  it("capped student is excluded by full_unrestricted — the gap this feature closes", () => {
    expect(computeEligibility({ work_rights_requirement: "full_unrestricted" }, "student_capped")).toBe("not_eligible");
    expect(computeEligibility({ work_rights_requirement: "any_valid" }, "student_capped")).toBe("eligible");
    expect(computeEligibility({ work_rights_requirement: "not_stated" }, "student_capped")).toBe("eligible");
  });

  it("offshore candidates hinge entirely on sponsorship", () => {
    expect(computeEligibility({ sponsorship_status: "yes", work_rights_requirement: "not_stated" }, "needs_sponsorship")).toBe("eligible");
    expect(computeEligibility({ sponsorship_status: "no", work_rights_requirement: "not_stated" }, "needs_sponsorship")).toBe("not_eligible");
    expect(computeEligibility({ sponsorship_status: "not_mentioned", work_rights_requirement: "any_valid" }, "needs_sponsorship")).toBe("not_eligible");
    expect(computeEligibility({ sponsorship_status: "not_mentioned", work_rights_requirement: "not_stated" }, "needs_sponsorship")).toBe("unclear");
  });

  it("maps legacy citizen_pr_only rows (pre-080) to the pr_citizen requirement", () => {
    expect(computeEligibility({ citizen_pr_only: true }, "student_capped")).toBe("not_eligible");
    expect(computeEligibility({ citizen_pr_only: true }, "pr")).toBe("eligible");
  });

  it("unknown/missing requirement values fall back to not_stated", () => {
    expect(computeEligibility({ work_rights_requirement: "bogus" }, "student_capped")).toBe("eligible");
    expect(computeEligibility({}, "pr")).toBe("eligible");
  });
});

describe("hoursCapConflict", () => {
  it("flags a capped student against an exclusively full-time job", () => {
    expect(hoursCapConflict({ employment_types: ["full_time"] }, "student_capped")).toBe(true);
  });

  it("does not flag a capped student when the job has any non-full-time type", () => {
    expect(hoursCapConflict({ employment_types: ["full_time", "part_time"] }, "student_capped")).toBe(false);
    expect(hoursCapConflict({ employment_types: ["casual"] }, "student_capped")).toBe(false);
  });

  it("does not flag a capped student when the job has no employment types at all", () => {
    expect(hoursCapConflict({ employment_types: [] }, "student_capped")).toBe(false);
    expect(hoursCapConflict({}, "student_capped")).toBe(false);
  });

  it("never flags a non-student status regardless of the job's employment types", () => {
    expect(hoursCapConflict({ employment_types: ["full_time"] }, "citizen")).toBe(false);
    expect(hoursCapConflict({ employment_types: ["full_time"] }, "needs_sponsorship")).toBe(false);
  });
});

describe("isUserVisaStatus", () => {
  it("accepts the five statuses, rejects junk", () => {
    for (const s of ["citizen", "pr", "temp_unrestricted", "student_capped", "needs_sponsorship"]) {
      expect(isUserVisaStatus(s)).toBe(true);
    }
    expect(isUserVisaStatus("permanent")).toBe(false);
    expect(isUserVisaStatus(undefined)).toBe(false);
  });

  it("REGRESSION (B5-P2): rejects Object.prototype keys — 'toString' is not a real visa status", () => {
    for (const key of ["toString", "constructor", "hasOwnProperty", "valueOf", "__proto__"]) {
      expect(isUserVisaStatus(key)).toBe(false);
    }
  });
});

describe("computeEligibility — prototype-key poisoning (B5-P2)", () => {
  it("REGRESSION: a bogus work_rights_requirement of 'toString' must not silently pass through as a real requirement", () => {
    expect(computeEligibility({ work_rights_requirement: "toString" }, "citizen")).toBe("eligible");
    expect(computeEligibility({ work_rights_requirement: "constructor" }, "citizen")).toBe("eligible");
  });
});

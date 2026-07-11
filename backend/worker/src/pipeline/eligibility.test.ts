import { describe, it, expect } from "vitest";
import { computeEligibility, hoursCapConflict, isUserVisaStatus } from "./eligibility.js";

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
  it("warns a capped student on exclusively full-time jobs only", () => {
    expect(hoursCapConflict({ employment_types: ["full_time"] }, "student_capped")).toBe(true);
    expect(hoursCapConflict({ employment_types: ["full_time", "part_time"] }, "student_capped")).toBe(false);
    expect(hoursCapConflict({ employment_types: [] }, "student_capped")).toBe(false);
    expect(hoursCapConflict({ employment_types: ["full_time"] }, "pr")).toBe(false);
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
});

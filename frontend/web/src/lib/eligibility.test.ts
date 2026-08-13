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
import { computeEligibility, isUserVisaStatus } from "./eligibility";

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

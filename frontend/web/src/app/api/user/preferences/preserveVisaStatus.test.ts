// Regression cover for finding #40 (chunk C16): PATCH /api/user/preferences
// replaces contact_details wholesale. sanitise() never knows about
// visa_status (owned by the separate /api/user/visa-status route + its own
// read-merge-write), so every autosave from this route silently wiped it.
import { describe, it, expect } from "vitest";
import { preserveVisaStatus } from "./route";

describe("preserveVisaStatus", () => {
  it("carries the existing visa_status across a contact_details replace", () => {
    const sanitised = { name: "Jane Citizen", phone: "0400000000" };
    const existing = { name: "Jane Citizen", visa_status: "student_capped" };
    expect(preserveVisaStatus(sanitised, existing)).toEqual({
      name: "Jane Citizen",
      phone: "0400000000",
      visa_status: "student_capped",
    });
  });

  it("is a no-op when there was never a stored visa_status", () => {
    const sanitised = { name: "Jane Citizen" };
    expect(preserveVisaStatus(sanitised, { name: "Jane Citizen" })).toEqual({
      name: "Jane Citizen",
    });
    expect(preserveVisaStatus(sanitised, null)).toEqual({ name: "Jane Citizen" });
  });

  it("ignores a non-string visa_status on the stored row (defensive)", () => {
    const sanitised = { name: "Jane Citizen" };
    expect(preserveVisaStatus(sanitised, { visa_status: 123 })).toEqual({
      name: "Jane Citizen",
    });
  });

  it("does not let a stale visa_status override one sanitise() already produced", () => {
    // sanitise() never sets visa_status today, but this future-proofs the
    // helper against ever silently reverting an intentional client update.
    const sanitised = { name: "Jane Citizen", visa_status: "citizen" };
    const existing = { visa_status: "student_capped" };
    expect(preserveVisaStatus(sanitised, existing)).toEqual({
      name: "Jane Citizen",
      visa_status: "citizen",
    });
  });

  it("does not mutate the sanitised input object", () => {
    const sanitised = { name: "Jane Citizen" };
    const existing = { visa_status: "pr" };
    preserveVisaStatus(sanitised, existing);
    expect(sanitised).toEqual({ name: "Jane Citizen" });
  });
});

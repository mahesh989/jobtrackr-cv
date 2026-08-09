/**
 * Regression test for the 2026-08-09 password-reset redirect bug: a recovery
 * link (PKCE/code-exchange flow) was landing users on /onboarding/plan
 * instead of the update-password form, because handleAuthConfirm's ONLY
 * recovery signal was `?type=recovery`, which Supabase never sets on this
 * flow — only exchangeCodeForSession's runtime-only `redirectType` field
 * carries it. isRecoveryLink is the extracted decision handleAuthConfirm
 * calls; it's tested here rather than the full route handler, matching this
 * repo's convention of testing the pure logic out of an I/O orchestrator
 * (see getDashboardData.test.ts) rather than mocking the Supabase client.
 */
import { describe, it, expect } from "vitest";
import { isRecoveryLink } from "./confirm";

describe("isRecoveryLink", () => {
  it("REGRESSION: recognises a recovery link from redirectType alone — the PKCE/code-exchange case that broke", () => {
    // otpType is null because Supabase's code-exchange flow never puts
    // type=recovery in the query string. redirectType is the only signal.
    expect(isRecoveryLink(null, "recovery")).toBe(true);
  });

  it("recognises a recovery link from otpType alone — the legacy hash-fragment / token_hash case", () => {
    expect(isRecoveryLink("recovery", null)).toBe(true);
    expect(isRecoveryLink("recovery", undefined)).toBe(true);
  });

  it("recognises a recovery link when both signals agree", () => {
    expect(isRecoveryLink("recovery", "recovery")).toBe(true);
  });

  it("does NOT treat a real OAuth callback as recovery — otpType and redirectType both absent", () => {
    expect(isRecoveryLink(null, null)).toBe(false);
    expect(isRecoveryLink(null, undefined)).toBe(false);
  });

  it("does NOT treat magic-link/signup confirmation as recovery", () => {
    expect(isRecoveryLink("magiclink", null)).toBe(false);
    expect(isRecoveryLink("signup", null)).toBe(false);
    expect(isRecoveryLink("invite", null)).toBe(false);
    expect(isRecoveryLink("email", null)).toBe(false);
  });
});

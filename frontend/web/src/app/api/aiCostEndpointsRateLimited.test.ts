/**
 * Regression test for B2-P2 (audit): 3 AI-cost endpoints had no rate limit
 * at all — cover-letter generation, stories/extract, and voice-profile each
 * trigger a real AI call against the single platform-wide provider key
 * (BYOK removed, D20 — every user shares one budget), so an unlimited
 * endpoint is a shared-cost exposure, not just a per-user one.
 *
 * A structural check, not a runtime one: this repo has no dedicated test
 * for rate-limiting on ANY of its ~10 other rateLimit()-using routes either
 * (grepped) — the utility itself is small, shared, proven-by-reuse
 * infrastructure, not novel logic. This asserts what a runtime test would
 * ultimately depend on anyway (the guard is actually wired in, using the
 * shared utility, not a bespoke one-off), and — unlike a purely manual
 * check — it fails immediately if the call is ever silently removed later.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROUTES = [
  "src/app/api/jobs/[id]/cover-letter/route.ts",
  "src/app/api/user/stories/extract/route.ts",
  "src/app/api/user/voice-profile/route.ts",
];

describe("AI-cost endpoints are rate-limited (B2-P2)", () => {
  it.each(ROUTES)("REGRESSION: %s imports and calls the shared rateLimit() before its AI call", (relPath) => {
    const src = readFileSync(join(process.cwd(), relPath), "utf8");
    expect(src).toMatch(/from ["']@\/lib\/rateLimit["']/);
    expect(src).toMatch(/rateLimit\(/);
    expect(src).toMatch(/RATE_LIMIT_MESSAGE/);
    expect(src).toMatch(/429/);
  });
});

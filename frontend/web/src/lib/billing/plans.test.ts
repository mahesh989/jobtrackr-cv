/**
 * Parity guard (audit, execution chunk C41d): plan limits are hand-maintained
 * in 4 places — the DB seed (shared/supabase/migrations/003_seed.sql, the
 * documented AUTHORITATIVE source), this file's PLAN_LIMITS (typed TS
 * mirror + UI fallback), backend/worker/src/automation/billing.ts's
 * PLAN_CV_LIMITS (cv-only fallback), and backend/api/app/services/automation
 * /billing.py's _PLAN_LETTER_LIMITS (letter-only fallback). Each file's own
 * comment says "keep in sync" as an unenforced manual convention — nothing
 * previously asserted they actually agree. This test (and its sibling in
 * the worker and api packages) hardcodes the seed's values as ground truth
 * and asserts this file's own PLAN_LIMITS against it, so a future edit to
 * one file without the others fails immediately instead of silently
 * drifting.
 *
 * GROUND_TRUTH below must be updated by hand whenever
 * shared/supabase/migrations/003_seed.sql's plan values change — there is
 * no automated cross-language import, per the investigation that scoped
 * this chunk (a shared fixture file was considered and rejected as more
 * infra than the drift risk currently warrants; revisit if a fourth
 * language/package ever needs the same values).
 */
import { describe, it, expect } from "vitest";
import { PLAN_LIMITS, type PlanLimits } from "./plans";

const GROUND_TRUTH: Record<string, PlanLimits> = {
  trial: {
    maxProfiles: 1, maxRuns: 1,
    maxCvUnique: 3, maxCvTotal: 3, maxLetterUnique: 3, maxLetterTotal: 3,
  },
  weekly: {
    maxProfiles: 5, maxRuns: 30,
    maxCvUnique: 50, maxCvTotal: 75, maxLetterUnique: 50, maxLetterTotal: 75,
  },
  monthly: {
    maxProfiles: 10, maxRuns: 120,
    maxCvUnique: 250, maxCvTotal: 375, maxLetterUnique: 250, maxLetterTotal: 375,
  },
  unlimited: {
    maxProfiles: null, maxRuns: null,
    maxCvUnique: null, maxCvTotal: null, maxLetterUnique: null, maxLetterTotal: null,
  },
  comp: {
    maxProfiles: null, maxRuns: null,
    maxCvUnique: null, maxCvTotal: null, maxLetterUnique: null, maxLetterTotal: null,
  },
};

describe("PLAN_LIMITS matches the DB seed (003_seed.sql) — parity guard", () => {
  it.each(Object.keys(GROUND_TRUTH))("plan %s matches the seed dimension-by-dimension", (planId) => {
    expect(PLAN_LIMITS[planId as keyof typeof PLAN_LIMITS]).toEqual(GROUND_TRUTH[planId]);
  });

  it("covers every plan id the seed defines — no plan silently unchecked", () => {
    expect(Object.keys(PLAN_LIMITS).sort()).toEqual(Object.keys(GROUND_TRUTH).sort());
  });
});

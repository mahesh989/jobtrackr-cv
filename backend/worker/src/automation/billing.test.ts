/**
 * Parity guard (audit, execution chunk C41d): see the sibling test in
 * frontend/web/src/lib/billing/plans.test.ts for the full rationale — plan
 * limits are hand-maintained in 4 places (DB seed, plans.ts, this file's
 * PLAN_CV_LIMITS, api billing.py's _PLAN_LETTER_LIMITS), each with a "keep
 * in sync" comment but no automated cross-check before this chunk.
 *
 * GROUND_TRUTH's cv-dimension values must be updated by hand whenever
 * shared/supabase/migrations/003_seed.sql's plan values change.
 */
import { describe, it, expect, vi } from "vitest";

// billing.ts imports the Supabase client module-level, which throws at
// import time without SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY set.
// PLAN_CV_LIMITS itself never touches the db, so stub the client rather
// than requiring env (same pattern as bucket.test.ts/dedup.test.ts).
vi.mock("../db/client.js", () => ({ db: {} }));

const { PLAN_CV_LIMITS } = await import("./billing.js");

const GROUND_TRUTH: Record<string, { unique: number | null; total: number | null }> = {
  trial:     { unique: 3,    total: 3    },
  weekly:    { unique: 50,   total: 75   },
  monthly:   { unique: 250,  total: 375  },
  unlimited: { unique: null, total: null },
  comp:      { unique: null, total: null },
};

describe("PLAN_CV_LIMITS matches the DB seed (003_seed.sql) — parity guard", () => {
  it.each(Object.keys(GROUND_TRUTH))("plan %s matches the seed's cv_unique/cv_total", (planId) => {
    expect(PLAN_CV_LIMITS[planId]).toEqual(GROUND_TRUTH[planId]);
  });

  it("covers every plan id the seed defines — no plan silently unchecked", () => {
    expect(Object.keys(PLAN_CV_LIMITS).sort()).toEqual(Object.keys(GROUND_TRUTH).sort());
  });
});

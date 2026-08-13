/**
 * Regression test for #46 (audit): Adzuna's "full JD = Unlimited only"
 * paywall was a no-op in two ways —
 *   1. description_snippet was written un-truncated, so a free tier
 *      reading it as its fallback (projectDescription) got the FULL JD.
 *   2. a later free-tier re-scrape of a job whose full JD had already been
 *      captured (jd_access='unlimited_only') overwrote description_full
 *      with null — a free re-scrape destroyed already-paid-for content.
 *
 * deriveDescriptionFields() is the pure function bucket.ts's write path
 * (upsertGlobalJobs) delegates to for the jd_access/description_snippet/
 * description_full triple — tested directly here rather than through the
 * full upsert (which needs DB + geocoding mocked for no additional
 * coverage of this logic).
 */
import { describe, it, expect, vi } from "vitest";

// bucket.ts imports the Supabase client module-level, which throws at
// import time without SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY set.
// deriveDescriptionFields itself never touches the db, so stub the client
// rather than requiring env (same pattern as dedup.test.ts).
vi.mock("../db/client.js", () => ({ db: {} }));

const { deriveDescriptionFields } = await import("./bucket.js");

const FULL_JD = "x".repeat(3000);

describe("deriveDescriptionFields", () => {
  it("REGRESSION (#46): truncates description_snippet for an unlimited_only row instead of writing the full JD", () => {
    const r = deriveDescriptionFields("adzuna", /* adzunaFull */ true, FULL_JD, null);
    expect(r.jd_access).toBe("unlimited_only");
    expect(r.description_full).toBe(FULL_JD);
    expect(r.description_snippet).not.toBe(FULL_JD);
    expect(r.description_snippet!.length).toBeLessThan(FULL_JD.length);
  });

  it("REGRESSION (#46): a free-tier re-scrape does not null out an already-captured paid full JD", () => {
    const priorTeaser = "y".repeat(600);
    const r = deriveDescriptionFields("adzuna", /* adzunaFull */ false, priorTeaser, {
      jd_access: "unlimited_only",
      description_full: FULL_JD,
    });
    expect(r.jd_access).toBe("unlimited_only");
    expect(r.description_full).toBe(FULL_JD);
  });

  it("a genuine snippet-only row (never had a paid full JD) still nulls description_full", () => {
    const teaser = "z".repeat(500);
    const r = deriveDescriptionFields("adzuna", /* adzunaFull */ false, teaser, null);
    expect(r.jd_access).toBe("snippet");
    expect(r.description_full).toBeNull();
    expect(r.description_snippet).toBe(teaser);
  });

  it("a direct-scrape run that successfully re-fetches the full JD overwrites with its own fresh copy", () => {
    const fresherFull = "w".repeat(3000);
    const r = deriveDescriptionFields("adzuna", /* adzunaFull */ true, fresherFull, {
      jd_access: "unlimited_only",
      description_full: FULL_JD,
    });
    expect(r.description_full).toBe(fresherFull);
  });

  it("non-Adzuna sources are never gated and never truncated", () => {
    const r = deriveDescriptionFields("seek", false, FULL_JD, null);
    expect(r.jd_access).toBe("all");
    expect(r.description_full).toBe(FULL_JD);
    expect(r.description_snippet).toBe(FULL_JD);
  });

  it("a short Adzuna description is left untouched by truncation (no-op for real API teasers)", () => {
    const shortTeaser = "short teaser text";
    const r = deriveDescriptionFields("adzuna", false, shortTeaser, null);
    expect(r.description_snippet).toBe(shortTeaser);
  });
});

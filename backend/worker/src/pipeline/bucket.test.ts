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
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import type { NormalisedJob } from "./types.js";

// bucket.ts imports the Supabase client module-level, which throws at
// import time without SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY set. Stub the
// client rather than requiring env (same pattern as dedup.test.ts);
// `currentDb` lets each test swap in its own fake without re-mocking
// (same pattern as coverage.test.ts).
let currentDb: unknown = {};
vi.mock("../db/client.js", () => ({
  get db() {
    return currentDb;
  },
}));

const { bucketEnabled, deriveDescriptionFields, projectDescription, upsertGlobalJobs, evictStaleBucket } =
  await import("./bucket.js");

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

// ---------------------------------------------------------------------------
// C67: bucket.ts had zero coverage beyond deriveDescriptionFields. The rest
// of the module — the flag gate, the tier-projection gate, and the
// write-path merge/dedup logic — is added below. serveProfileFromBucket's
// geo-query building (bounding box, coverage-slice fallback) is
// deliberately NOT covered here — mocking its Supabase query-builder chain
// plus geocoding would be a much larger, separate effort than this pass's
// scope; flagging as a real gap rather than quietly declaring this module
// "characterized".
// ---------------------------------------------------------------------------

describe("bucketEnabled", () => {
  const ORIGINAL = process.env.USE_GLOBAL_BUCKET;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.USE_GLOBAL_BUCKET;
    else process.env.USE_GLOBAL_BUCKET = ORIGINAL;
  });

  it("is false when the env var is unset", () => {
    delete process.env.USE_GLOBAL_BUCKET;
    expect(bucketEnabled()).toBe(false);
  });

  it("is false for any value other than the exact string 'true'", () => {
    process.env.USE_GLOBAL_BUCKET = "1";
    expect(bucketEnabled()).toBe(false);
    process.env.USE_GLOBAL_BUCKET = "TRUE";
    expect(bucketEnabled()).toBe(false);
  });

  it("is true only for the exact string 'true'", () => {
    process.env.USE_GLOBAL_BUCKET = "true";
    expect(bucketEnabled()).toBe(true);
  });
});

describe("projectDescription", () => {
  const row = {
    description_full: "the full job description text",
    description_snippet: "a short teaser",
  } as Parameters<typeof projectDescription>[0];

  it("gives an unlimited-only Adzuna row's full JD only to an unlimited-tier reader", () => {
    const unlimitedOnly = { ...row, jd_access: "unlimited_only" as const };
    expect(projectDescription(unlimitedOnly, "unlimited")).toBe(row.description_full);
  });

  it("gives an unlimited-only Adzuna row's SNIPPET to a non-unlimited reader — the paywall gate", () => {
    const unlimitedOnly = { ...row, jd_access: "unlimited_only" as const };
    expect(projectDescription(unlimitedOnly, "weekly")).toBe(row.description_snippet);
    expect(projectDescription(unlimitedOnly, "monthly")).toBe(row.description_snippet);
  });

  it("gives the full JD to every tier when jd_access is 'all' (SEEK/Careerjet)", () => {
    const allAccess = { ...row, jd_access: "all" as const };
    expect(projectDescription(allAccess, "weekly")).toBe(row.description_full);
  });

  it("falls back to the snippet when description_full is null", () => {
    const noFull = { ...row, description_full: null, jd_access: "all" as const };
    expect(projectDescription(noFull, "unlimited")).toBe(row.description_snippet);
  });

  it("falls back to empty string when both are null", () => {
    const empty = { ...row, description_full: null, description_snippet: null, jd_access: "all" as const };
    expect(projectDescription(empty, "unlimited")).toBe("");
  });
});

function bucketJob(overrides: Partial<NormalisedJob> = {}): NormalisedJob {
  return {
    url: "https://example.com/job/1",
    url_hash: "hash-1",
    content_hash: "chash-1",
    title: "Registered Nurse",
    company: "Example Health",
    // Deliberately blank so upsertGlobalJobs's per-job geocode branch
    // (`j.location ? await geocodeLocation(...) : null`) is skipped —
    // keeps these tests focused on the merge/dedup logic without also
    // needing to mock geocodeLocation.
    location: "",
    description: "full description text",
    source: "seek",
    source_tier: 1,
    posted_at: null,
    expires_at: null,
    keywords_matched: ["ain"],
    dedup_status: "original",
    duplicate_of: null,
    repost_of: null,
    sponsorship_status: "not_mentioned",
    citizen_pr_only: null,
    visa_extracted_text: null,
    setting_category: null,
    setting_confidence: null,
    setting_evidence: null,
    distance_km: null,
    distance_method: null,
    ...overrides,
  };
}

/** Fake `db` supporting exactly the chains upsertGlobalJobs/evictStaleBucket
 * use: `.from("global_jobs").select(...).in(...)` (existing-rows lookup),
 * `.from("global_jobs").upsert(...)`, and `.from("global_jobs").delete().lt(...)`. */
function fakeBucketDb(opts: {
  existingRows?: Array<Record<string, unknown>>;
  upsertError?: { message: string } | null;
  deleteError?: { message: string } | null;
}) {
  const upsertCalls: Array<Array<Record<string, unknown>>> = [];
  const db = {
    from(table: string) {
      if (table !== "global_jobs") throw new Error(`unexpected table: ${table}`);
      return {
        select() {
          return { in: () => Promise.resolve({ data: opts.existingRows ?? [], error: null }) };
        },
        upsert(rows: Array<Record<string, unknown>>) {
          upsertCalls.push(rows);
          return Promise.resolve({ error: opts.upsertError ?? null });
        },
        delete() {
          return { lt: () => Promise.resolve({ error: opts.deleteError ?? null }) };
        },
      };
    },
  };
  return { db, upsertCalls };
}

describe("upsertGlobalJobs", () => {
  const ORIGINAL = process.env.USE_GLOBAL_BUCKET;
  beforeEach(() => {
    process.env.USE_GLOBAL_BUCKET = "true";
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.USE_GLOBAL_BUCKET;
    else process.env.USE_GLOBAL_BUCKET = ORIGINAL;
  });

  it("is a no-op returning true when the flag is off, even with jobs to write", async () => {
    process.env.USE_GLOBAL_BUCKET = "false";
    const { db, upsertCalls } = fakeBucketDb({});
    currentDb = db;
    const ok = await upsertGlobalJobs([bucketJob()], { adzunaFull: false });
    expect(ok).toBe(true);
    expect(upsertCalls).toHaveLength(0);
  });

  it("is a no-op returning true for an empty jobs array", async () => {
    const { db, upsertCalls } = fakeBucketDb({});
    currentDb = db;
    const ok = await upsertGlobalJobs([], { adzunaFull: false });
    expect(ok).toBe(true);
    expect(upsertCalls).toHaveLength(0);
  });

  it("merges incoming matched_keywords with the existing bucket row's, not overwriting them", async () => {
    const { db, upsertCalls } = fakeBucketDb({
      existingRows: [{ url_hash: "hash-1", matched_keywords: ["personal care assistant"], lat: null, lng: null, setting_category: null, setting_confidence: null, setting_evidence: null, jd_access: null, description_full: null }],
    });
    currentDb = db;
    await upsertGlobalJobs([bucketJob({ keywords_matched: ["ain"] })], { adzunaFull: false });
    const written = upsertCalls[0][0];
    expect(written.matched_keywords).toEqual(expect.arrayContaining(["ain", "personal care assistant"]));
  });

  it("never lets a non-classifying run's null setting clobber an existing setting classification", async () => {
    const { db, upsertCalls } = fakeBucketDb({
      existingRows: [{ url_hash: "hash-1", matched_keywords: [], lat: null, lng: null, setting_category: "residential_aged_care", setting_confidence: 0.9, setting_evidence: "aged care facility", jd_access: null, description_full: null }],
    });
    currentDb = db;
    // This run's own setting_category is null (e.g. a non-healthcare profile).
    await upsertGlobalJobs([bucketJob({ setting_category: null, setting_confidence: null, setting_evidence: null })], { adzunaFull: false });
    const written = upsertCalls[0][0];
    expect(written.setting_category).toBe("residential_aged_care");
    expect(written.setting_confidence).toBe(0.9);
  });

  it("a fresh classification from this run overrides the existing one", async () => {
    const { db, upsertCalls } = fakeBucketDb({
      existingRows: [{ url_hash: "hash-1", matched_keywords: [], lat: null, lng: null, setting_category: "other", setting_confidence: 0.5, setting_evidence: "stale", jd_access: null, description_full: null }],
    });
    currentDb = db;
    await upsertGlobalJobs([bucketJob({ setting_category: "residential_aged_care", setting_confidence: 0.95, setting_evidence: "fresh evidence" })], { adzunaFull: false });
    const written = upsertCalls[0][0];
    expect(written.setting_category).toBe("residential_aged_care");
    expect(written.setting_evidence).toBe("fresh evidence");
  });

  it("de-dupes incoming jobs sharing a url_hash, keeping the first", async () => {
    const { db, upsertCalls } = fakeBucketDb({ existingRows: [] });
    currentDb = db;
    await upsertGlobalJobs(
      [bucketJob({ title: "First" }), bucketJob({ title: "Second" })],
      { adzunaFull: false },
    );
    expect(upsertCalls[0]).toHaveLength(1);
    expect(upsertCalls[0][0].title).toBe("First");
  });

  it("returns false (not throw) when the upsert fails, so callers know the write may not have landed", async () => {
    const { db } = fakeBucketDb({ upsertError: { message: "connection reset" } });
    currentDb = db;
    const ok = await upsertGlobalJobs([bucketJob()], { adzunaFull: false });
    expect(ok).toBe(false);
  });

  it("returns false (not throw) when the db client itself throws", async () => {
    currentDb = {
      from() {
        throw new Error("client not initialised");
      },
    };
    const ok = await upsertGlobalJobs([bucketJob()], { adzunaFull: false });
    expect(ok).toBe(false);
  });
});

describe("evictStaleBucket", () => {
  const ORIGINAL = process.env.USE_GLOBAL_BUCKET;
  beforeEach(() => {
    process.env.USE_GLOBAL_BUCKET = "true";
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.USE_GLOBAL_BUCKET;
    else process.env.USE_GLOBAL_BUCKET = ORIGINAL;
  });

  it("is a no-op when the flag is off", async () => {
    process.env.USE_GLOBAL_BUCKET = "false";
    let deleteCalled = false;
    currentDb = {
      from() {
        deleteCalled = true;
        return { delete: () => ({ lt: () => Promise.resolve({ error: null }) }) };
      },
    };
    await evictStaleBucket();
    expect(deleteCalled).toBe(false);
  });

  it("never throws when the delete errors — best-effort by design", async () => {
    const { db } = fakeBucketDb({ deleteError: { message: "timeout" } });
    currentDb = db;
    await expect(evictStaleBucket()).resolves.toBeUndefined();
  });
});

/**
 * C67: the pre-upsert existence probe (which url_hashes already exist for
 * this profile, snapshotted BEFORE the upsert so new-vs-re-touched can be
 * told apart) discarded its own error entirely. A failed probe left
 * existingRows null → `?? []` silently became an empty Set → every hash in
 * the batch read as "new", even old, already-saved jobs from a prior run —
 * inflating newSaved into a false "new jobs" notification for stale
 * postings the user had already seen.
 */
import { describe, it, expect, vi } from "vitest";
import type { NormalisedJob } from "./types.js";

let currentDb: unknown = {};
vi.mock("../db/client.js", () => ({
  get db() {
    return currentDb;
  },
}));

const { saveJobs } = await import("./save.js");

function job(overrides: Partial<NormalisedJob> = {}): NormalisedJob {
  return {
    url: "https://example.com/job/1",
    url_hash: "hash-1",
    content_hash: "chash-1",
    title: "Registered Nurse",
    company: "Example Health",
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
  } as NormalisedJob;
}

/** Fake db: `.select().eq().in()` (existence probe) resolves per `probeResult`;
 *  `.upsert().select()` resolves per `upsertResult`. */
function fakeDb(
  probeResult: { data: Array<{ url_hash: string }> | null; error: { message: string } | null },
  upsertResult: { data: Array<{ id: string }> | null; error: { message: string } | null; count?: number },
) {
  return {
    from() {
      return {
        select: () => ({
          eq: () => ({
            in: () => Promise.resolve(probeResult),
          }),
        }),
        upsert: () => ({
          select: () => Promise.resolve({ ...upsertResult, count: upsertResult.count ?? 1 }),
        }),
      };
    },
  };
}

describe("saveJobs — existence-probe failure handling", () => {
  it("counts a job as new when the probe succeeds and finds nothing existing", async () => {
    currentDb = fakeDb(
      { data: [], error: null },
      { data: [{ id: "row-1" }], error: null },
    );
    const result = await saveJobs([job({ url_hash: "hash-new" })], "profile-1");
    expect(result.newSaved).toBe(1);
  });

  it("does NOT count a job as new when the probe succeeds and finds it already exists", async () => {
    currentDb = fakeDb(
      { data: [{ url_hash: "hash-old" }], error: null },
      { data: [{ id: "row-1" }], error: null },
    );
    const result = await saveJobs([job({ url_hash: "hash-old" })], "profile-1");
    expect(result.newSaved).toBe(0);
  });

  it("REGRESSION: does not falsely count an OLD job as new when the existence probe itself fails", async () => {
    currentDb = fakeDb(
      { data: null, error: { message: "connection reset" } },
      { data: [{ id: "row-1" }], error: null },
    );
    // This job may well already exist (that's exactly what the probe failed
    // to tell us) — the fix must not default to "new" on probe failure.
    const result = await saveJobs([job({ url_hash: "hash-unknown" })], "profile-1");
    expect(result.newSaved).toBe(0);
    expect(result.saved).toBe(1); // the upsert itself still succeeded
  });
});

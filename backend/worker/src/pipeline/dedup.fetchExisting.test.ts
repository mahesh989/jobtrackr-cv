/**
 * C67: fetchExistingJobsForProfile (dedup.ts) had no .order() before its
 * .limit(5000) — PostgREST's row choice for an unordered LIMIT is
 * unspecified, so a profile with more than 5000 non-duplicate jobs got an
 * arbitrary, run-to-run-unstable 5000 instead of a consistent set, silently
 * missing real duplicates. Its error was also discarded — a failed fetch
 * silently returned an empty "existing" set, defeating cross-run dedup
 * entirely with no error surfaced anywhere.
 */
import { describe, it, expect, vi } from "vitest";
import type { NormalisedJob } from "./types.js";

let currentDb: unknown = {};
vi.mock("../db/client.js", () => ({
  get db() {
    return currentDb;
  },
}));

const { dedup } = await import("./dedup.js");

function job(url: string): NormalisedJob {
  return {
    url,
    url_hash: "",
    content_hash: "",
    title: "Registered Nurse",
    company: "Acme",
    location: "Sydney NSW",
    description: "",
    source: "seek",
    source_tier: 1,
    posted_at: null,
    expires_at: null,
    keywords_matched: [],
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
  };
}

/** Records the query chain calls and resolves with `result`. */
function fakeDb(result: { data: unknown[] | null; error: { message: string } | null }) {
  const calls: string[] = [];
  const chain = {
    select: (...a: unknown[]) => { calls.push(`select(${JSON.stringify(a)})`); return chain; },
    eq:     (...a: unknown[]) => { calls.push(`eq(${JSON.stringify(a)})`); return chain; },
    neq:    (...a: unknown[]) => { calls.push(`neq(${JSON.stringify(a)})`); return chain; },
    order:  (...a: unknown[]) => { calls.push(`order(${JSON.stringify(a)})`); return chain; },
    limit:  (...a: unknown[]) => { calls.push(`limit(${JSON.stringify(a)})`); return Promise.resolve(result); },
  };
  return { db: { from: () => chain }, calls };
}

describe("dedup — existing-jobs fetch (cross-run dedup)", () => {
  it("orders by created_at (most-recent-first) before the 5000 cap so a truncation is deterministic", async () => {
    const { db, calls } = fakeDb({ data: [], error: null });
    currentDb = db;

    await dedup([job("https://example.com/job/1")], "profile-1");

    const orderIdx = calls.findIndex((c) => c.startsWith("order("));
    const limitIdx = calls.findIndex((c) => c.startsWith("limit("));
    expect(orderIdx).toBeGreaterThan(-1);
    expect(orderIdx).toBeLessThan(limitIdx);
    expect(calls[orderIdx]).toContain("created_at");
  });

  it("REGRESSION: does not crash and logs when the existing-jobs fetch errors, instead of silently defeating cross-run dedup", async () => {
    const { db } = fakeDb({ data: null, error: { message: "connection reset" } });
    currentDb = db;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await dedup([job("https://example.com/job/1")], "profile-1");

    // Falls back to treating "existing" as empty (graceful degrade) rather
    // than throwing — but the failure must be visible, not silent.
    expect(result.kept).toHaveLength(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("connection reset"));
    errSpy.mockRestore();
  });
});

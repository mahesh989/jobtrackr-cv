/**
 * C67: on a failed Apify actor call (non-ok response or a thrown fetch),
 * enrichAdzunaJDsViaActor billed the FULL run cost and reported
 * `fetched: targets.length` — as if the run had succeeded — even though
 * zero descriptions were merged. That both overcharges for a failure and
 * masks it from source_methods, the diagnostic surface for paid-tier
 * source failures.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NormalisedJob } from "../pipeline/types.js";

function adzunaJob(url: string): NormalisedJob {
  return {
    url,
    url_hash: "", content_hash: "",
    title: "Registered Nurse", company: "Acme", location: "Sydney",
    description: "teaser", source: "adzuna", source_tier: 1,
    posted_at: null, expires_at: null,
    keywords_matched: [], dedup_status: "original",
    duplicate_of: null, repost_of: null,
    sponsorship_status: "not_mentioned", citizen_pr_only: null,
    visa_extracted_text: null, setting_category: null,
    setting_confidence: null, setting_evidence: null,
    distance_km: null, distance_method: null,
  } as NormalisedJob;
}

const JOBS = [adzunaJob("https://www.adzuna.com.au/details/123")];

describe("enrichAdzunaJDsViaActor — failure billing", () => {
  beforeEach(() => {
    process.env.ADZUNA_ACTOR_ID = "test-actor";
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ADZUNA_ACTOR_ID;
  });

  it("REGRESSION: reports zero cost and zero fetched on a non-ok Apify response, instead of billing a failed run as a full success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false, status: 500, text: async () => "actor crashed",
    } as Response)));
    const { enrichAdzunaJDsViaActor } = await import("./adzunaActor.js");

    const result = await enrichAdzunaJDsViaActor(JOBS, "token");

    expect(result.costUsd).toBe(0);
    expect(result.fetched).toBe(0);
    expect(result.merged).toBe(0);
  });

  it("REGRESSION: reports zero cost and zero fetched when the actor call itself throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network error"); }));
    const { enrichAdzunaJDsViaActor } = await import("./adzunaActor.js");

    const result = await enrichAdzunaJDsViaActor(JOBS, "token");

    expect(result.costUsd).toBe(0);
    expect(result.fetched).toBe(0);
  });

  it("still bills the run cost + reports fetched on a genuine success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => [{ url: "https://www.adzuna.com.au/details/123", description: "x".repeat(600) }],
    } as Response)));
    const { enrichAdzunaJDsViaActor } = await import("./adzunaActor.js");

    const result = await enrichAdzunaJDsViaActor(JOBS, "token");

    expect(result.fetched).toBe(1);
    expect(result.merged).toBe(1);
    expect(result.costUsd).toBeGreaterThan(0);
  });
});

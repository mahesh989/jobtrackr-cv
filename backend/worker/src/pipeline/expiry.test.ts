// Stage 9 expiry check — regression cover for finding #53 (chunk C13).
//
// parseCloseDate used to hand a matched date substring straight to `new
// Date(...)`, which parses slash-separated dates as US month/day, not AU
// day/month. For a day-first date like "03/04/2026" (3 April), that reads
// as March 4th — a date that can already be in the past while the real
// closing date is still weeks away. The job then gets is_expired: true and
// is hidden from the board while it's genuinely still accepting
// applications — "hides live jobs permanently" per the audit finding.
//
// Fixed by reusing extractClosingDate (ai/jdFacts.ts), the same
// AU-day-first parser already used and tested for job-facts extraction.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkExpiry } from "./expiry.js";
import type { NormalisedJob } from "./types.js";

function job(overrides: Partial<NormalisedJob> = {}): NormalisedJob {
  return {
    url: "https://example.com/job/1",
    url_hash: "hash1",
    content_hash: "chash1",
    title: "Registered Nurse",
    company: "Example Health",
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
    ...overrides,
  };
}

describe("checkExpiry — AU day-first closing-date parsing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not hide a job whose real (day-first) closing date is still weeks away", () => {
    // "03/04/2026" is 3 April 2026 under AU day-first convention. "now" is
    // set to 15 March — the real closing date is 19 days in the future.
    vi.setSystemTime(new Date("2026-03-15T00:00:00Z"));
    const result = checkExpiry(
      job({ description: "Applications close 03/04/2026. Apply now." }),
    );
    expect(result.is_expired).toBe(false);
    expect(result.expires_at).toBe("2026-04-03T00:00:00.000Z");
  });

  it("correctly expires a job once its real closing date has passed", () => {
    vi.setSystemTime(new Date("2026-04-10T00:00:00Z"));
    const result = checkExpiry(
      job({ description: "Applications close 03/04/2026. Apply now." }),
    );
    expect(result.is_expired).toBe(true);
    expect(result.expires_at).toBe("2026-04-03T00:00:00.000Z");
  });

  it("parses an unambiguous day-first date (day > 12) that the old US-order parser dropped entirely", () => {
    // new Date("25/03/2026") is Invalid Date under US month/day order
    // (month=25 doesn't exist) — the old code silently returned null here.
    vi.setSystemTime(new Date("2026-03-01T00:00:00Z"));
    const result = checkExpiry(
      job({ description: "Closing date: 25/03/2026" }),
    );
    expect(result.expires_at).toBe("2026-03-25T00:00:00.000Z");
    expect(result.is_expired).toBe(false);
  });

  it("still honours a structured expires_at over any description scan", () => {
    vi.setSystemTime(new Date("2026-03-15T00:00:00Z"));
    const result = checkExpiry(
      job({
        expires_at: "2026-06-01T00:00:00.000Z",
        description: "Applications close 03/04/2026.",
      }),
    );
    expect(result.is_expired).toBe(false);
    expect(result.expires_at).toBe("2026-06-01T00:00:00.000Z");
  });

  it("still applies the 60-day-since-posted heuristic when no closing date is stated", () => {
    vi.setSystemTime(new Date("2026-03-15T00:00:00Z"));
    const result = checkExpiry(
      job({
        posted_at: "2026-01-01T00:00:00.000Z", // 73 days before "now"
        description: "A great role with no explicit closing date.",
      }),
    );
    expect(result.is_expired).toBe(true);
    expect(result.expires_at).toBeNull();
  });

  it("returns not-expired with no signal when the description has no close-date language", () => {
    vi.setSystemTime(new Date("2026-03-15T00:00:00Z"));
    const result = checkExpiry(job({ description: "A great role, apply today!" }));
    expect(result.is_expired).toBe(false);
    expect(result.expires_at).toBeNull();
  });
});

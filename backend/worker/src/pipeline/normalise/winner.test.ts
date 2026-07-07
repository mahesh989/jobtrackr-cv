import { describe, it, expect } from "vitest";
import { scoreJob } from "./winner.js";
import type { NormalisedJob } from "../types.js";

function job(overrides: Partial<NormalisedJob>): NormalisedJob {
  return {
    url: "https://example.com/job/1",
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
    ...overrides,
  };
}

describe("scoreJob", () => {
  it("prefers SEEK over Jora even with a much shorter description", () => {
    const seekJob = job({ source: "seek", description: "short" });
    const joraJob = job({ source: "jora", description: "x".repeat(1000) });
    expect(scoreJob(seekJob)).toBeGreaterThan(scoreJob(joraJob));
  });

  it("scores a job with salary present higher than an identical job without", () => {
    const withSalary = job({ salary_min: 80000 });
    const withoutSalary = job({});
    expect(scoreJob(withSalary)).toBeGreaterThan(scoreJob(withoutSalary));
  });
});

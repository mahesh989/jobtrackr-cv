import { describe, it, expect } from "vitest";
import { excludeByDescription } from "./postFetchFilter.js";
import type { NormalisedJob } from "./types.js";
import type { SearchProfile } from "../sources/types.js";

function job(description: string): NormalisedJob {
  return {
    url: "https://example.com/job/1",
    url_hash: "",
    content_hash: "",
    title: "Support Worker",
    company: "Acme",
    location: "Sydney NSW",
    description,
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

function profile(excludeKeywords: string): SearchProfile {
  return { adzuna_exclude_keywords: excludeKeywords } as SearchProfile;
}

describe("excludeByDescription", () => {
  it("drops a job whose description matches an excluded phrase and attributes it", () => {
    const jobs = [job("Must have home care experience")];
    const result = excludeByDescription(jobs, profile("home care"));
    expect(result.kept).toHaveLength(0);
    expect(result.dropped).toBe(1);
    expect(result.byPhrase["home care"]).toBe(1);
  });

  it("keeps a job whose description has no excluded phrase", () => {
    const jobs = [job("Acute care hospital ward experience")];
    const result = excludeByDescription(jobs, profile("home care"));
    expect(result.kept).toHaveLength(1);
    expect(result.dropped).toBe(0);
  });
});

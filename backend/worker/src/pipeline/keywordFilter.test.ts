import { describe, it, expect } from "vitest";
import { titleOnlyFilter } from "./keywordFilter.js";
import type { NormalisedJob } from "./types.js";

function job(title: string): NormalisedJob {
  return {
    url: "https://example.com/job/1",
    url_hash: "",
    content_hash: "",
    title,
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

describe("titleOnlyFilter", () => {
  it("matches a single-word phrase at a word boundary", () => {
    const jobs = [job("SQL Developer")];
    expect(titleOnlyFilter(jobs, ["SQL"])).toHaveLength(1);
  });

  it("does not match the phrase as a substring of a longer word", () => {
    const jobs = [job("MySQL Admin")];
    expect(titleOnlyFilter(jobs, ["SQL"])).toHaveLength(0);
  });
});

import { describe, it, expect } from "vitest";
import { applySettingFilter } from "./settingFilter.js";
import type { NormalisedJob } from "./types.js";
import type { SearchProfile } from "../sources/types.js";

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

function profile(setting_filter: string[]): SearchProfile {
  return { setting_filter } as SearchProfile;
}

describe("applySettingFilter", () => {
  const selection = profile(["hospital_clinical"]);

  it("keeps unclassified (null category) jobs even when not selected", () => {
    const jobs = [job({ setting_category: null })];
    expect(applySettingFilter(jobs, selection).kept).toHaveLength(1);
  });

  it("keeps 'other' category jobs even when not selected", () => {
    const jobs = [job({ setting_category: "other" })];
    expect(applySettingFilter(jobs, selection).kept).toHaveLength(1);
  });

  it("keeps low-confidence classifications even when the category isn't selected", () => {
    const jobs = [
      job({ setting_category: "residential_aged_care", setting_confidence: 0.5 }),
    ];
    expect(applySettingFilter(jobs, selection).kept).toHaveLength(1);
  });

  it("drops a confident, unselected category", () => {
    const jobs = [
      job({ setting_category: "residential_aged_care", setting_confidence: 0.9 }),
    ];
    const result = applySettingFilter(jobs, selection);
    expect(result.kept).toHaveLength(0);
    expect(result.byCategory["residential_aged_care"]).toBe(1);
  });
});

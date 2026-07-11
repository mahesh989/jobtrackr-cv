import { describe, it, expect } from "vitest";
import { extractVisaInfo } from "./visaExtractor.js";
import type { NormalisedJob } from "../pipeline/types.js";

// Deterministic-tier tests only: every fixture phrase matches the regex
// rules, so the AI fallback is never invoked (no env/API needed).

function job(description: string): NormalisedJob {
  return {
    url: "https://example.com/j",
    url_hash: `h-${description.length}-${description.slice(0, 24)}`,
    content_hash: "",
    title: "Registered Nurse",
    company: "Acme Care",
    location: "Sydney, NSW",
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

async function requirementFor(description: string): Promise<string | undefined> {
  const j = job(description);
  const map = await extractVisaInfo([j]);
  return map.get(j.url_hash)?.work_rights_requirement;
}

describe("work_rights_requirement axis", () => {
  it("no visa language at all → not_stated", async () => {
    expect(await requirementFor("Join our friendly aged care team in Parramatta.")).toBe("not_stated");
  });

  it("'right to work in Australia' → any_valid (NOT full_unrestricted)", async () => {
    expect(
      await requirementFor("Applicants must have the right to work in Australia.")
    ).toBe("any_valid");
  });

  it("'full working rights' → full_unrestricted (excludes capped students)", async () => {
    expect(
      await requirementFor("You must hold full working rights with no restrictions to be considered.")
    ).toBe("full_unrestricted");
    expect(
      await requirementFor("Unrestricted working rights required for this permanent position.")
    ).toBe("full_unrestricted");
  });

  it("citizens/PR phrasing → pr_citizen", async () => {
    expect(
      await requirementFor("Only Australian citizens and permanent residents will be considered.")
    ).toBe("pr_citizen");
  });

  it("security clearance → citizen_only", async () => {
    expect(
      await requirementFor("An NV1 security clearance is required for this role.")
    ).toBe("citizen_only");
    expect(
      await requirementFor("Baseline clearance essential. Applications close soon.")
    ).toBe("citizen_only");
  });

  it("requirement and sponsorship stay orthogonal", async () => {
    const j = job("Visa sponsorship is available for the right candidate with a valid working visa.");
    const map = await extractVisaInfo([j]);
    const info = map.get(j.url_hash)!;
    expect(info.sponsorship_status).toBe("yes");
    expect(info.work_rights_requirement).toBe("any_valid");
  });
});

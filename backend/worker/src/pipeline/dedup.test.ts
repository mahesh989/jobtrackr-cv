import { describe, it, expect, vi } from "vitest";
import type { NormalisedJob } from "./types.js";

// dedup.ts imports the Supabase client module-level, which throws at import
// time without SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY set. computeHashes
// itself never touches the db, so stub the client rather than requiring env.
vi.mock("../db/client.js", () => ({ db: {} }));

const { computeHashes, scoreOf } = await import("./dedup.js");

function existingJob(source: string, description = ""): {
  id: string;
  url_hash: string;
  title: string;
  company: string;
  location: string;
  source: string;
  description?: string | null;
} {
  return {
    id: "1",
    url_hash: "abc",
    title: "Registered Nurse",
    company: "Acme",
    location: "Sydney NSW",
    source,
    description,
  };
}

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

describe("computeHashes", () => {
  it("produces the same url_hash for URLs differing only in case", () => {
    const a = computeHashes(job("https://example.com/Job/ABC"));
    const b = computeHashes(job("https://example.com/job/abc"));
    expect(a.url_hash).toBe(b.url_hash);
  });

  it("produces a different url_hash for genuinely different URLs", () => {
    const a = computeHashes(job("https://example.com/job/abc"));
    const b = computeHashes(job("https://example.com/job/xyz"));
    expect(a.url_hash).not.toBe(b.url_hash);
  });
});

describe("scoreOf (existing rows) — source bonus must match winner.ts's SOURCE_BONUS", () => {
  it("does not let careerjet outscore adzuna (careerjet is demoted to 300, below adzuna's 400)", () => {
    const careerjet = scoreOf({ kind: "existing", job: existingJob("careerjet") });
    const adzuna = scoreOf({ kind: "existing", job: existingJob("adzuna") });
    expect(adzuna).toBeGreaterThan(careerjet);
  });

  it("gives agedcare its authoritative 1800 bonus instead of silently falling through to 0", () => {
    const agedcare = scoreOf({ kind: "existing", job: existingJob("agedcare") });
    const adzuna = scoreOf({ kind: "existing", job: existingJob("adzuna") });
    expect(agedcare).toBeGreaterThan(adzuna);
  });
});

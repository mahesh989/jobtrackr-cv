/**
 * C67: posted_at was derived ONLY from Greenhouse's updated_at, which bumps
 * on ANY edit (a typo fix, a budget tweak) — a job posted months ago with a
 * trivial edit yesterday read as "posted yesterday", jumping ahead of
 * genuinely new postings on every recency-sorted/filtered view. Greenhouse's
 * public API exposes the job's true original publish date as
 * first_published; posted_at must prefer that, falling back to updated_at
 * only when first_published is genuinely absent.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// Real delay would be 300ms × ~40 hardcoded SLUGS — mock it out.
vi.mock("./agedCareRoles.js", () => ({ sleep: () => Promise.resolve() }));

import { greenhouseAdapter } from "./greenhouse.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function stubBoard(job: Record<string, unknown>) {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      jobs: [{
        id: 1,
        title: "Data Analyst",
        location: { name: "Sydney" },
        content: "<p>Full JD</p>",
        absolute_url: "https://example.com/job/1",
        ...job,
      }],
    }),
  } as Response)));
}

const PROFILE = { keywords: ["data"] } as never;

describe("greenhouseAdapter.fetchJobs — posted_at derivation", () => {
  it("uses first_published (the genuine original publish date), not updated_at", async () => {
    stubBoard({ first_published: "2026-01-01T00:00:00Z", updated_at: "2026-08-15T00:00:00Z" });

    const jobs = await greenhouseAdapter.fetchJobs(PROFILE);

    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs[0].posted_at).toBe("2026-01-01T00:00:00Z");
  });

  it("REGRESSION: falls back to updated_at when first_published is genuinely absent, rather than losing the date entirely", async () => {
    stubBoard({ updated_at: "2026-08-15T00:00:00Z" });

    const jobs = await greenhouseAdapter.fetchJobs(PROFILE);

    expect(jobs[0].posted_at).toBe("2026-08-15T00:00:00Z");
  });
});

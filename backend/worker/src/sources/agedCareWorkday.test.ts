/**
 * C67: fetchJobs threw the instant ANY tenant's list endpoint was
 * unreachable — which discarded every job already collected from tenants
 * processed earlier in the same loop, since sourceFetch.ts's catch branch
 * never uses a partial result from a thrown fetchJobs() call. One tenant's
 * Workday instance being down shouldn't poison jobs the other 7 tenants
 * already found.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { agedCareWorkdayAdapter } from "./agedCareWorkday.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const LIST_JOB = {
  title: "Registered Nurse",
  externalPath: "/job/Sydney/Registered-Nurse_JR1",
  locationsText: "Sydney",
};

function mockFetch(brokenTenant: string) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes(`${brokenTenant}.wd`) && url.includes("/jobs")) {
      throw new Error("network unreachable");
    }
    if (url.endsWith("/jobs")) {
      // LIST endpoint — one role-matched job, total=1 so pagination stops
      // after page 0 without ever hitting the inter-page sleep.
      return {
        ok: true,
        status: 200,
        json: async () => ({ total: 1, jobPostings: [LIST_JOB] }),
      } as Response;
    }
    // DETAIL endpoint
    return {
      ok: true,
      status: 200,
      json: async () => ({
        jobPostingInfo: {
          title: LIST_JOB.title,
          jobDescription: "<p>Full JD text</p>",
          location: "Sydney",
          startDate: "2026-08-01",
        },
      }),
    } as Response;
  }));
}

describe("agedCareWorkdayAdapter.fetchJobs — one tenant failing", () => {
  it("REGRESSION: keeps jobs from working tenants instead of discarding everything when one tenant's list endpoint is unreachable", async () => {
    mockFetch("anglicare"); // first tenant in TENANTS

    const jobs = await agedCareWorkdayAdapter.fetchJobs({} as never);

    // 7 of 8 tenants succeed, each contributing one matched job.
    expect(jobs.length).toBe(7);
    expect(jobs.every((j) => j.title === "Registered Nurse")).toBe(true);
  });

  it("still throws (to trigger the orchestrator's backoff) when literally every tenant fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network unreachable");
    }));

    await expect(agedCareWorkdayAdapter.fetchJobs({} as never)).rejects.toThrow(/unreachable/);
  });
});

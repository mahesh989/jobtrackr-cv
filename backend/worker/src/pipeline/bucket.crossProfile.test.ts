/**
 * C67: cross-profile dedup ("a job already in another of the user's
 * profiles shouldn't reappear in this one") is void in bucket mode.
 * earlyDedup.ts's stage 3b only filters the fresh scrape delta; the bucket
 * serve (serveProfileFromBucket) then replaces `toSave` wholesale with an
 * independent full-window re-serve from the shared bucket, so two of a
 * user's own profiles with overlapping criteria both got served the same
 * postings. dropServedCrossProfileDuplicates re-applies the sibling check
 * to that served set.
 */
import { describe, it, expect, vi } from "vitest";
import type { NormalisedJob } from "./types.js";

let currentDb: unknown = {};
vi.mock("../db/client.js", () => ({
  get db() {
    return currentDb;
  },
}));

const { dropServedCrossProfileDuplicates } = await import("./bucket.js");

function job(url_hash: string): NormalisedJob {
  return { url: `https://x.com/${url_hash}`, url_hash } as NormalisedJob;
}

/** search_profiles → sibling ids; jobs → existing url_hashes in those siblings. */
function fakeDb(siblingIds: string[], existingHashesInSiblings: string[]) {
  return {
    from(table: string) {
      if (table === "search_profiles") {
        return {
          select: () => ({
            eq: () => ({
              neq: () => Promise.resolve({ data: siblingIds.map((id) => ({ id })), error: null }),
            }),
          }),
        };
      }
      if (table === "jobs") {
        return {
          select: () => ({
            in: () => ({
              in: () => Promise.resolve({
                data: existingHashesInSiblings.map((url_hash) => ({ url_hash })),
                error: null,
              }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  };
}

describe("dropServedCrossProfileDuplicates", () => {
  it("drops a served job already present in a sibling profile", async () => {
    currentDb = fakeDb(["sibling-1"], ["hash-dupe"]);
    const jobs = [job("hash-dupe"), job("hash-unique")];

    const result = await dropServedCrossProfileDuplicates(jobs, "profile-1", "user-1");

    expect(result.jobs.map((j) => j.url_hash)).toEqual(["hash-unique"]);
    expect(result.dropped).toBe(1);
  });

  it("returns the served set unchanged when the user has no sibling profiles", async () => {
    currentDb = fakeDb([], []);
    const jobs = [job("hash-a"), job("hash-b")];

    const result = await dropServedCrossProfileDuplicates(jobs, "profile-1", "user-1");

    expect(result.jobs).toEqual(jobs);
    expect(result.dropped).toBe(0);
  });

  it("returns the served set unchanged (fails open) when the sibling lookup errors", async () => {
    currentDb = {
      from: () => ({
        select: () => ({
          eq: () => ({
            neq: () => Promise.resolve({ data: null, error: { message: "connection reset" } }),
          }),
        }),
      }),
    };
    const jobs = [job("hash-a")];

    const result = await dropServedCrossProfileDuplicates(jobs, "profile-1", "user-1");

    expect(result.jobs).toEqual(jobs);
    expect(result.dropped).toBe(0);
  });
});

/**
 * Regression test for #34 (audit, execution chunk C34): planBucketCoverage
 * discarded WHICH slices acquireSliceLocks actually claimed and recorded the
 * FULL `stale` list (including cold slices, which were never locked at all)
 * as `lockedSlices`. runPipeline.ts later calls releaseSliceLocks(lockedSlices)
 * unconditionally — so on a partial claim, this run released a DIFFERENT
 * in-flight run's lock on the slices it failed to claim, letting a third run
 * double-scrape that slice (paid Apify/Adzuna calls doubled).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CoverageSlice } from "../coverage.js";
import type { FullProfile } from "./types.js";

const resolveSlicesMock = vi.fn();
const readCoverageMock = vi.fn();
const computeProfileLookbackMock = vi.fn();
const sliceDeltaDaysMock = vi.fn();
const acquireSliceLocksMock = vi.fn();
vi.mock("../coverage.js", () => ({
  resolveSlices: (...args: unknown[]) => resolveSlicesMock(...args),
  readCoverage: (...args: unknown[]) => readCoverageMock(...args),
  computeProfileLookback: (...args: unknown[]) => computeProfileLookbackMock(...args),
  sliceDeltaDays: (...args: unknown[]) => sliceDeltaDaysMock(...args),
  acquireSliceLocks: (...args: unknown[]) => acquireSliceLocksMock(...args),
}));

const bucketEnabledMock = vi.fn();
const evictStaleBucketMock = vi.fn();
vi.mock("../bucket.js", () => ({
  bucketEnabled: () => bucketEnabledMock(),
  evictStaleBucket: () => evictStaleBucketMock(),
  BUCKET_RETENTION_DAYS: 30,
}));

const { planBucketCoverage } = await import("./bucketCoverage.js");

function slice(keyword: string): CoverageSlice {
  return { keyword_norm: keyword, location_cell: "sydney", source: "seek" };
}

const profile = { enabled_sources: ["seek"], keywords: ["nurse"], location: "Sydney" } as unknown as FullProfile;

describe("planBucketCoverage", () => {
  beforeEach(() => {
    bucketEnabledMock.mockReset().mockReturnValue(true);
    evictStaleBucketMock.mockReset().mockResolvedValue(undefined);
    resolveSlicesMock.mockReset().mockReturnValue([slice("a"), slice("b"), slice("c")]);
    computeProfileLookbackMock.mockReset();
    sliceDeltaDaysMock.mockReset();
    acquireSliceLocksMock.mockReset();
  });

  it("REGRESSION (#34): lockedSlices is only what acquireSliceLocks actually claimed on a partial claim, not the full stale list", async () => {
    const stale = [slice("a"), slice("b"), slice("c")];
    readCoverageMock.mockResolvedValue(new Map([
      ["a|sydney|seek", { last_refreshed_at: "2020-01-01" }],
      ["b|sydney|seek", { last_refreshed_at: "2020-01-01" }],
      ["c|sydney|seek", { last_refreshed_at: "2020-01-01" }],
    ]));
    computeProfileLookbackMock.mockReturnValue({ lookbackDays: 5, allFresh: false });
    sliceDeltaDaysMock.mockReturnValue(5); // every slice stale, none cold (all have coverage rows)
    // Only "a" and "c" actually claimed — "b" is held by another in-flight run.
    acquireSliceLocksMock.mockResolvedValue([slice("a"), slice("c")]);

    const result = await planBucketCoverage(profile, 5, false);

    expect(result.lockedSlices.map((s) => s.keyword_norm)).toEqual(["a", "c"]);
    expect(result.lockedSlices).not.toEqual(stale);
    expect(result.skipScrape).toBe(false);
  });

  it("skips the scrape when acquireSliceLocks claims nothing (every stale slice already locked elsewhere)", async () => {
    readCoverageMock.mockResolvedValue(new Map([
      ["a|sydney|seek", { last_refreshed_at: "2020-01-01" }],
      ["b|sydney|seek", { last_refreshed_at: "2020-01-01" }],
      ["c|sydney|seek", { last_refreshed_at: "2020-01-01" }],
    ]));
    computeProfileLookbackMock.mockReturnValue({ lookbackDays: 5, allFresh: false });
    sliceDeltaDaysMock.mockReturnValue(5);
    acquireSliceLocksMock.mockResolvedValue([]);

    const result = await planBucketCoverage(profile, 5, false);

    expect(result.skipScrape).toBe(true);
    expect(result.lockedSlices).toEqual([]);
  });

  it("REGRESSION (#34): cold slices (never locked, no coverage row) never appear in lockedSlices", async () => {
    // "a" has a coverage row (stale, lockable); "b" and "c" are cold (no row at all).
    readCoverageMock.mockResolvedValue(new Map([
      ["a|sydney|seek", { last_refreshed_at: "2020-01-01" }],
    ]));
    computeProfileLookbackMock.mockReturnValue({ lookbackDays: 30, allFresh: false });
    sliceDeltaDaysMock.mockImplementation((row: unknown) => (row ? 5 : 30));
    acquireSliceLocksMock.mockResolvedValue([slice("a")]);

    const result = await planBucketCoverage(profile, 5, false);

    expect(result.lockedSlices.map((s) => s.keyword_norm)).toEqual(["a"]);
    expect(result.skipScrape).toBe(false);
    // acquireSliceLocks must only be called with the non-cold stale slices.
    expect(acquireSliceLocksMock).toHaveBeenCalledWith([slice("a")]);
  });
});

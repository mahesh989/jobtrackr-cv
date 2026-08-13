/**
 * Regression test for #34 (audit, execution chunk C34): acquireSliceLocks
 * returned only a COUNT of claimed slices, discarding WHICH ones. The only
 * caller (bucketCoverage.ts) used that count purely as a zero-check and then
 * recorded the FULL input list as "locked by me" regardless of how many
 * actually claimed — so on a partial claim, releasing later released a
 * DIFFERENT in-flight run's lock on the slices this call failed to claim,
 * letting a third run double-scrape that slice (paid Apify/Adzuna calls
 * doubled).
 *
 * Fix: acquireSliceLocks now returns the actual slices claimed.
 */
import { describe, it, expect, vi } from "vitest";
import type { CoverageSlice } from "./coverage.js";

let currentDb: unknown;
vi.mock("../db/client.js", () => ({
  get db() {
    return currentDb;
  },
}));

const { acquireSliceLocks } = await import("./coverage.js");

function slice(keyword: string): CoverageSlice {
  return { keyword_norm: keyword, location_cell: "sydney", source: "seek" };
}

/** Fake db: `claimedByKeyword` says which slices this call successfully
 * claims (data.length > 0) vs. finds already locked (data: []). */
function fakeDb(claimedByKeyword: Record<string, boolean>) {
  return {
    from(table: string) {
      if (table !== "search_coverage") throw new Error(`unexpected table: ${table}`);
      let keywordNorm = "";
      const chain = {
        update() {
          return chain;
        },
        eq(column: string, value: string) {
          if (column === "keyword_norm") keywordNorm = value;
          return chain;
        },
        or() {
          return chain;
        },
        select() {
          const ok = claimedByKeyword[keywordNorm] ?? false;
          return Promise.resolve({ data: ok ? [{ id: "row-1" }] : [] });
        },
      };
      return chain;
    },
  };
}

describe("acquireSliceLocks", () => {
  it("REGRESSION (#34): returns exactly the slices claimed on a partial claim, not all of them", async () => {
    currentDb = fakeDb({ a: true, b: false, c: true });

    const claimed = await acquireSliceLocks([slice("a"), slice("b"), slice("c")]);

    expect(claimed.map((s) => s.keyword_norm)).toEqual(["a", "c"]);
  });

  it("returns every slice when all are claimed", async () => {
    currentDb = fakeDb({ a: true, b: true });

    const claimed = await acquireSliceLocks([slice("a"), slice("b")]);

    expect(claimed.map((s) => s.keyword_norm)).toEqual(["a", "b"]);
  });

  it("returns an empty array when none are claimed", async () => {
    currentDb = fakeDb({ a: false, b: false });

    const claimed = await acquireSliceLocks([slice("a"), slice("b")]);

    expect(claimed).toEqual([]);
  });

  it("returns an empty array for an empty input without touching the db", async () => {
    currentDb = fakeDb({});

    const claimed = await acquireSliceLocks([]);

    expect(claimed).toEqual([]);
  });
});

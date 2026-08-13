/**
 * Regression tests for the `.in()` bug family (audit, execution chunk C44).
 * Proves selectInChunked never issues a single query with more than
 * chunkSize values — the exact shape that silently returns `data: null`
 * against real PostgREST — while still returning the full, correctly
 * aggregated result set. Mirrors backend/worker/src/db/chunkedIn.test.ts.
 */
import { describe, it, expect, vi } from "vitest";
import { selectInChunked } from "./chunkedIn";

describe("selectInChunked", () => {
  it("returns empty, non-null results without calling the query for an empty input", async () => {
    const queryForChunk = vi.fn();
    const result = await selectInChunked([], queryForChunk);
    expect(result).toEqual({ rows: [], hadError: false });
    expect(queryForChunk).not.toHaveBeenCalled();
  });

  it("issues a single query when the input fits in one chunk", async () => {
    const values = Array.from({ length: 50 }, (_, i) => `v${i}`);
    const queryForChunk = vi.fn().mockResolvedValue({ data: values.map((v) => ({ id: v })), error: null });
    const result = await selectInChunked(values, queryForChunk, 150);
    expect(queryForChunk).toHaveBeenCalledTimes(1);
    expect(queryForChunk).toHaveBeenCalledWith(values);
    expect(result.rows).toHaveLength(50);
    expect(result.hadError).toBe(false);
  });

  it("REGRESSION: never sends a single chunk larger than chunkSize, and aggregates every chunk's rows", async () => {
    const values = Array.from({ length: 401 }, (_, i) => `v${i}`);
    const queryForChunk = vi.fn().mockImplementation((chunk: string[]) =>
      Promise.resolve({ data: chunk.map((v) => ({ id: v })), error: null }),
    );
    const result = await selectInChunked<{ id: string }>(values, queryForChunk, 150);

    expect(queryForChunk).toHaveBeenCalledTimes(3); // 150 + 150 + 101
    for (const call of queryForChunk.mock.calls) {
      expect(call[0].length).toBeLessThanOrEqual(150);
    }
    expect(result.rows).toHaveLength(401);
    expect(result.rows.map((r) => r.id).sort()).toEqual([...values].sort());
    expect(result.hadError).toBe(false);
  });

  it("skips a failed chunk instead of throwing, and still returns rows from the chunks that succeeded", async () => {
    const values = Array.from({ length: 300 }, (_, i) => `v${i}`);
    let call = 0;
    const queryForChunk = vi.fn().mockImplementation((chunk: string[]) => {
      call++;
      if (call === 1) return Promise.resolve({ data: null, error: { message: "boom" } });
      return Promise.resolve({ data: chunk.map((v) => ({ id: v })), error: null });
    });
    const result = await selectInChunked(values, queryForChunk, 150);

    expect(queryForChunk).toHaveBeenCalledTimes(2);
    expect(result.hadError).toBe(true);
    expect(result.rows).toHaveLength(150); // only the second (successful) chunk's rows
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { triggerReanalyze, AnalyzeApiError } from "./analyzeJob";

// C67: the API returns distinct outcomes by HTTP status (429 rate-limited,
// 402 quota/billing, 404 not found, 422 validation, 502 upstream) — a bare
// Error discarded the status, so no caller could special-case any of them.

afterEach(() => {
  vi.restoreAllMocks();
});

describe("triggerReanalyze", () => {
  it("returns the run_id on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ run_id: "run-1" }),
    }));
    await expect(triggerReanalyze("job-1")).resolves.toBe("run-1");
  });

  it("throws an AnalyzeApiError carrying the response status on failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 402,
      json: async () => ({ error: "Quota exceeded" }),
    }));

    await expect(triggerReanalyze("job-1")).rejects.toMatchObject({
      message: "Quota exceeded",
      status: 402,
    });
  });

  it("is still a plain Error for callers that only check instanceof Error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    }));

    try {
      await triggerReanalyze("job-1");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect(e).toBeInstanceOf(AnalyzeApiError);
      expect((e as AnalyzeApiError).status).toBe(500);
    }
  });
});

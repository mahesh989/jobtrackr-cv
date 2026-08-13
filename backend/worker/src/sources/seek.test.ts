/**
 * Regression test for #23 (audit, execution chunk C30): the SEEK Apify
 * adapter swallowed auth/HTTP failures — on a non-ok response or a thrown
 * fetch error, fetchJobs() resolved normally with {jobs: [], costUsd},
 * indistinguishable from a legitimate zero-result search. The caller
 * (sourceFetch.ts) only marks the integration invalid / skips billing
 * inside a catch block — which never ran, because fetchJobs never threw.
 * Net effect: a dead/expired Apify token got quota billed AND its status
 * reset to "valid" on every single run, permanently hiding the failure.
 *
 * Fix: fetchJobs now THROWS on both failure paths, letting the caller's
 * already-correct catch-block handling (mark invalid, skip billing) run
 * as originally designed.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createSeekAdapter } from "./seek.js";
import type { SearchProfile } from "./types.js";

const profile = {
  id: "profile-1",
  keywords: ["registered nurse"],
  location: "Sydney",
  visa_filter_mode: "off",
} as unknown as SearchProfile;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createSeekAdapter().fetchJobs", () => {
  it("REGRESSION (#23): throws (does not resolve with an empty success) on a non-ok HTTP response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => "Invalid or expired Apify token",
      }),
    );

    const adapter = createSeekAdapter("dead-token");

    await expect(adapter.fetchJobs(profile)).rejects.toThrow(/401/);
  });

  it("REGRESSION (#23): throws (does not resolve with an empty success) when the fetch itself fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network unreachable")));

    const adapter = createSeekAdapter("some-token");

    await expect(adapter.fetchJobs(profile)).rejects.toThrow(/network unreachable/);
  });

  it("still resolves normally with jobs on a genuine success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => [
          { id: "1", title: "Registered Nurse", company: "Acme", location: "Sydney NSW", url: "https://seek.com.au/job/1" },
        ],
      }),
    );

    const adapter = createSeekAdapter("good-token");
    const result = await adapter.fetchJobs(profile);

    expect(result.jobs).toHaveLength(1);
    expect(result.costUsd).toBeGreaterThan(0);
  });
});

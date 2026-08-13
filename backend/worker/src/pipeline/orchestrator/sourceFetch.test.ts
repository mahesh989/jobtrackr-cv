import { describe, it, expect, vi } from "vitest";

// sourceFetch.ts transitively imports several modules that construct real
// clients (Supabase, Redis) at import time and throw without env vars —
// mock them away, matching this suite's established convention for testing
// pure logic out of a module with I/O side effects at import time (see
// dedup.test.ts's db/client.js mock). shouldMarkSeekCovered itself touches
// none of these; they're only import-time baggage of the file it lives in.
vi.mock("../../db/client.js", () => ({ db: {} }));
vi.mock("../../queue/connection.js", () => ({ connection: {} }));

import { shouldMarkSeekCovered } from "./sourceFetch.js";

/**
 * Regression tests for B5-P2 (audit): "a run that skipped scraping still
 * marks SEEK slices freshly covered, creating a self-sustaining skip loop
 * for SEEK-only profiles". The original inline condition
 * (`seekEnabled && (seekRawCount > 0 || !seekDirectFailed)`) omitted the
 * bucketSkipScrape check — seekDirectFailed only ever flips to true inside
 * the branch that actually attempts a fetch, so on a bucket-skip run it sat
 * at its unset default `false`, and `!seekDirectFailed` evaluated `true` as
 * if a real, successful (even if empty) attempt had been made.
 */
describe("shouldMarkSeekCovered", () => {
  it("REGRESSION: a bucket-skip run (scraping never attempted) is NOT marked covered", () => {
    // This is the exact bug: bucketSkipScrape=true means seekDirectFailed
    // never got set away from its false default, and the old condition
    // read that as "direct succeeded (legitimately empty)".
    expect(
      shouldMarkSeekCovered({
        seekEnabled: true,
        bucketSkipScrape: true,
        seekRawCount: 0,
        seekDirectFailed: false,
      }),
    ).toBe(false);
  });

  it("a disabled source is never marked covered, regardless of the other flags", () => {
    expect(
      shouldMarkSeekCovered({
        seekEnabled: false,
        bucketSkipScrape: false,
        seekRawCount: 5,
        seekDirectFailed: false,
      }),
    ).toBe(false);
  });

  it("direct succeeded with real results is covered", () => {
    expect(
      shouldMarkSeekCovered({
        seekEnabled: true,
        bucketSkipScrape: false,
        seekRawCount: 12,
        seekDirectFailed: false,
      }),
    ).toBe(true);
  });

  it("direct succeeded but legitimately found zero jobs is still covered (a real attempt, a real empty answer)", () => {
    expect(
      shouldMarkSeekCovered({
        seekEnabled: true,
        bucketSkipScrape: false,
        seekRawCount: 0,
        seekDirectFailed: false,
      }),
    ).toBe(true);
  });

  it("direct failed and no fallback ever ran (0 results) is NOT covered — retried next run", () => {
    expect(
      shouldMarkSeekCovered({
        seekEnabled: true,
        bucketSkipScrape: false,
        seekRawCount: 0,
        seekDirectFailed: true,
      }),
    ).toBe(false);
  });

  it("direct failed but the Apify fallback recovered results is covered", () => {
    expect(
      shouldMarkSeekCovered({
        seekEnabled: true,
        bucketSkipScrape: false,
        seekRawCount: 8,
        seekDirectFailed: true,
      }),
    ).toBe(true);
  });
});

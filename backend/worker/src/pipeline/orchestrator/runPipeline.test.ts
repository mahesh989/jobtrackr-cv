/**
 * Regression test for #35 (audit, execution chunk C35): runPipeline() only
 * called releaseSliceLocks() on the success path, right before "run
 * complete". Any exception thrown between acquiring a bucket-coverage
 * single-flight lock and that line — a real, reachable window (source
 * fetch failure, dedup error, save error, etc.) — left the lock held until
 * LOCK_STALE_MINUTES (10 min) auto-expired it, silently forcing every
 * profile sharing that slice onto bucket-only serving for up to 10 minutes.
 *
 * Fix: the release now lives in a `finally` block, so it runs on every exit
 * path. This test forces a failure inside the pipeline (fetchFromSources
 * throws) and asserts releaseSliceLocks still fires.
 *
 * Every other orchestrator dependency is mocked with the minimum needed to
 * reach that failure point — none of them need realistic behaviour since
 * execution never proceeds past the injected throw.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CoverageSlice } from "../coverage.js";

vi.mock("../../db/client.js", () => ({
  db: {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
    }),
  },
}));
vi.mock("../normalise.js", () => ({ normalise: (j: unknown) => j }));
vi.mock("../keywordFilter.js", () => ({ applyKeywordFilter: (jobs: unknown[]) => jobs }));
vi.mock("../dedup.js", () => ({ dedup: async (jobs: unknown[]) => ({ kept: jobs, l1Dropped: 0, l2Dropped: 0, l2WeakMarked: 0 }) }));
vi.mock("../save.js", () => ({ saveJobs: async () => ({ saved: 0, errors: [] }) }));

const recordCoverageMock = vi.fn().mockResolvedValue(undefined);
const releaseSliceLocksMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../coverage.js", () => ({
  resolveSlices: () => [],
  recordCoverage: (...args: unknown[]) => recordCoverageMock(...args),
  releaseSliceLocks: (...args: unknown[]) => releaseSliceLocksMock(...args),
}));

vi.mock("../bucket.js", () => ({
  bucketEnabled: () => true,
  upsertGlobalJobs: async () => true,
  serveProfileFromBucket: async () => null,
  BUCKET_RETENTION_DAYS: 30,
}));
vi.mock("../postFetchFilter.js", () => ({
  postFetchFilter: (jobs: unknown[]) => ({ kept: jobs, droppedTitleMissing: 0, droppedTitleExcluded: 0, droppedDescExcluded: 0, descExcludedByPhrase: {} }),
  formatExcludeBreakdown: () => "",
}));
const finishRunLogMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../runLog.js", () => ({
  startRunLog: async () => "run-log-1",
  finishRunLog: (...args: unknown[]) => finishRunLogMock(...args),
  setStage: async () => undefined,
}));
vi.mock("../logContext.js", () => ({ runLogContext: { enterWith: () => undefined } }));
vi.mock("../eligibility.js", () => ({ computeEligibility: () => "eligible", isUserVisaStatus: () => false }));
vi.mock("../settingFilter.js", () => ({ applySettingFilter: (jobs: unknown[]) => ({ kept: jobs, dropped: 0, byCategory: {} }), formatSettingBreakdown: () => "" }));
const sendPipelineFailureAlertMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../../notifications/errorAlert.js", () => ({ sendPipelineFailureAlert: (...args: unknown[]) => sendPipelineFailureAlertMock(...args) }));
vi.mock("../../automation/triggerAutoAnalyze.js", () => ({ autoAnalyzeBatch: async () => ({ triggered: 0, skipped: 0 }) }));
vi.mock("../../lib/distance.js", () => ({
  geocode: async () => null,
  geocodeLocation: async () => null,
  distanceFor: async () => null,
}));
vi.mock("../../notifications/gate.js", () => ({ applyGate: async () => ({ proceed: true }) }));

const loadProfileMock = vi.fn();
vi.mock("./profile.js", () => ({
  loadProfile: (...args: unknown[]) => loadProfileMock(...args),
  normalizeWorkTypes: () => undefined,
}));
vi.mock("./platformSources.js", () => ({
  loadPlatformSources: async () => ({ tier: "weekly", enabled_sources: ["seek"], adzuna_method: "api", seek_method: "direct" }),
}));
vi.mock("./concurrency.js", () => ({ expireStaleAndCheckActiveRun: async () => true }));
vi.mock("./lookback.js", () => ({ computeLookbackWindow: async () => ({ deepRun: false, lookbackDays: 5 }) }));

const lockedSlice: CoverageSlice = { keyword_norm: "nurse", location_cell: "sydney", source: "seek" };
vi.mock("./bucketCoverage.js", () => ({
  planBucketCoverage: async () => ({
    slices: [lockedSlice],
    skipScrape: false,
    lockedSlices: [lockedSlice],
    lookbackDays: 5,
  }),
}));
vi.mock("./apifyIntegration.js", () => ({
  loadApifyCredential: async () => ({ integration: null, adapter: null, token: null }),
}));

const fetchFromSourcesMock = vi.fn();
vi.mock("./sourceFetch.js", () => ({ fetchFromSources: (...args: unknown[]) => fetchFromSourcesMock(...args) }));
vi.mock("./earlyDedup.js", () => ({ earlyDedup: async (jobs: unknown[]) => ({ jobs, dropped: 0 }) }));
vi.mock("./enrichment.js", () => ({ enrichDescriptions: async (jobs: unknown[]) => ({ jobs, descDropped: 0 }) }));
vi.mock("./jobFacts.js", () => ({ extractJobFacts: async (jobs: unknown[]) => jobs }));

const { runPipeline } = await import("./runPipeline.js");

describe("runPipeline — single-flight locks must be released on every exit path", () => {
  beforeEach(() => {
    releaseSliceLocksMock.mockClear();
    finishRunLogMock.mockClear();
    sendPipelineFailureAlertMock.mockClear();
    loadProfileMock.mockReset().mockResolvedValue({
      id: "profile-1",
      user_id: "user-1",
      name: "Test profile",
      is_manual: false,
      automation_enabled: false,
      home_address: null,
      home_lat: null,
      home_lng: null,
      keywords: ["nurse"],
      location: "Sydney",
      visa_filter_mode: "off",
    });
  });

  it("REGRESSION (#35): releases the bucket-coverage lock even when the pipeline throws mid-run", async () => {
    fetchFromSourcesMock.mockRejectedValue(new Error("source fetch exploded"));

    await runPipeline("profile-1", "manual", false);

    expect(releaseSliceLocksMock).toHaveBeenCalledTimes(1);
    expect(releaseSliceLocksMock).toHaveBeenCalledWith([lockedSlice]);
    // The failure path still ran (sanity check this really did fail, not skip).
    expect(finishRunLogMock).toHaveBeenCalledWith(
      "run-log-1",
      expect.objectContaining({ status: "failed" }),
    );
  });

  it("still releases the lock on the success path", async () => {
    fetchFromSourcesMock.mockResolvedValue([]);

    await runPipeline("profile-1", "manual", false);

    expect(releaseSliceLocksMock).toHaveBeenCalledTimes(1);
    expect(releaseSliceLocksMock).toHaveBeenCalledWith([lockedSlice]);
  });
});

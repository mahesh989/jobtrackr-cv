import { describe, it, expect, beforeEach, vi } from "vitest";
import type { SearchProfile } from "./types.js";

// Regression cover for the silent-failure bug: a 403 from the v4 API (bad key,
// or this egress IP not whitelisted on the Careerjet affiliate account) used to
// be caught and swallowed, so fetchJobs() returned [] and the orchestrator
// recorded a SUCCESS — which cleared the health counter, meaning isBlocked()
// could never fire and a fully-broken source looked like "0 matching jobs".

const EMPTY_RESULT = JSON.stringify({ type: "JOBS", jobs: [], pages: 1, hits: 0 });

let apiStatus = 200;
// The adapter JSON.parses the body, so this stays a raw string like got returns.
let apiBody = EMPTY_RESULT;

vi.mock("got-scraping", () => ({
  gotScraping: vi.fn(async ({ url }: { url: string }) => {
    if (url.includes("ipify")) return { statusCode: 200, body: "203.0.113.7" };
    return { statusCode: apiStatus, body: apiBody };
  }),
}));
vi.mock("../lib/proxy.js",     () => ({ getApifyProxyUrl: () => undefined }));
vi.mock("../lib/curlfetch.js", () => ({ curlFetch: vi.fn() }));

const profile = {
  keywords: ["nurse"],
  location: "Sydney",
  visa_filter_mode: "probability_sort",
} as unknown as SearchProfile;

async function loadAdapter() {
  vi.resetModules();
  process.env.CAREERJET_API_KEY = "test-key";
  return (await import("./careerjet.js")).careerjetAdapter;
}

describe("careerjetAdapter.fetchJobs — failure visibility", () => {
  beforeEach(() => {
    apiStatus = 200;
    apiBody = EMPTY_RESULT;
  });

  it("throws on 403 so the health tracker sees a failure", async () => {
    apiStatus = 403;
    apiBody = JSON.stringify({ error: "Unauthorized access from IP 79.127.166.167", type: "ERROR" });
    const adapter = await loadAdapter();
    await expect(adapter.fetchJobs(profile)).rejects.toThrow(/403/);
  });

  it("throws on 401 (bad API key) too", async () => {
    apiStatus = 401;
    apiBody = JSON.stringify({ error: "Unauthorized", type: "ERROR" });
    const adapter = await loadAdapter();
    await expect(adapter.fetchJobs(profile)).rejects.toThrow(/401/);
  });

  it("still returns [] for a genuine zero-hit search", async () => {
    // No error occurred — an empty result set is a legitimate success and must
    // NOT be reported as a failure, or a quiet search would block the source.
    const adapter = await loadAdapter();
    await expect(adapter.fetchJobs(profile)).resolves.toEqual([]);
  });

  it("reports failure when every request errored and nothing was fetched", async () => {
    apiStatus = 500;
    apiBody = "upstream exploded";
    const adapter = await loadAdapter();
    await expect(adapter.fetchJobs(profile)).rejects.toThrow(/500/);
  });
});

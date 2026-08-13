import { describe, it, expect, beforeEach, vi } from "vitest";

// Health state lives in the SAME Upstash instance for local dev and production
// (.env.example points both at one URL), so these tests pin the property that
// keeps a local run from blocking a source in production: the Redis keys are
// namespaced per deployment via FLY_APP_NAME.

const store = new Map<string, string>();
// expiresAt tracks a simulated Redis TTL as an absolute mockNow-relative
// timestamp (seconds), so isBlocked()'s probe-cooldown math (TTL_SECONDS -
// remaining TTL = time since last failure) is exercisable deterministically.
const expiresAt = new Map<string, number>();
let mockNow = 0; // seconds

vi.mock("../queue/connection.js", () => ({
  connection: {
    get:    vi.fn(async (k: string) => store.get(k) ?? null),
    del:    vi.fn(async (k: string) => { store.delete(k); expiresAt.delete(k); }),
    incr:   vi.fn(async (k: string) => {
      const next = parseInt(store.get(k) ?? "0", 10) + 1;
      store.set(k, String(next));
      return next;
    }),
    expire: vi.fn(async (k: string, seconds: number) => {
      expiresAt.set(k, mockNow + seconds);
      return 1;
    }),
    ttl: vi.fn(async (k: string) => {
      const at = expiresAt.get(k);
      if (at === undefined) return -2;
      const remaining = at - mockNow;
      return remaining > 0 ? remaining : -2;
    }),
  },
}));

/** Re-import the module with FLY_APP_NAME set (or not) — ENV_NS is resolved at
 *  module load, so each namespace needs a fresh module instance. */
async function loadWith(flyAppName: string | undefined) {
  vi.resetModules();
  if (flyAppName === undefined) delete process.env.FLY_APP_NAME;
  else process.env.FLY_APP_NAME = flyAppName;
  return import("./healthTracker.js");
}

describe("healthTracker key namespacing", () => {
  beforeEach(() => {
    store.clear();
    expiresAt.clear();
    mockNow = 0;
    delete process.env.FLY_APP_NAME;
  });

  it("namespaces under 'local' when FLY_APP_NAME is absent (dev machine)", async () => {
    const { recordFailure } = await loadWith(undefined);
    await recordFailure("careerjet");
    expect([...store.keys()]).toEqual(["jobtrackr:health:local:careerjet:failures"]);
  });

  it("namespaces under the Fly app name when deployed", async () => {
    const { recordFailure } = await loadWith("jobtrackr-worker");
    await recordFailure("careerjet");
    expect([...store.keys()]).toEqual(["jobtrackr:health:jobtrackr-worker:careerjet:failures"]);
  });

  it("keeps local failures from blocking the same source in production", async () => {
    // A dev runs the worker locally 3x; Careerjet 403s every time because the
    // home IP isn't whitelisted. Production must be unaffected.
    const local = await loadWith(undefined);
    await local.recordFailure("careerjet");
    await local.recordFailure("careerjet");
    await local.recordFailure("careerjet");
    expect(await local.isBlocked("careerjet")).toBe(true);

    const prod = await loadWith("jobtrackr-worker");
    expect(await prod.isBlocked("careerjet")).toBe(false);
  });

  it("blocks only at MAX_FAILURES consecutive failures, and a success clears it", async () => {
    const { recordFailure, recordSuccess, isBlocked } = await loadWith("jobtrackr-worker");
    await recordFailure("careerjet");
    await recordFailure("careerjet");
    expect(await isBlocked("careerjet")).toBe(false);

    await recordFailure("careerjet");
    expect(await isBlocked("careerjet")).toBe(true);

    await recordSuccess("careerjet");
    expect(await isBlocked("careerjet")).toBe(false);
  });
});

describe("healthTracker probe-cooldown (B5-P2: a source blocked by transient failures could never clear its own counter)", () => {
  beforeEach(() => {
    store.clear();
    expiresAt.clear();
    mockNow = 0;
    delete process.env.FLY_APP_NAME;
  });

  it("REGRESSION: stays blocked immediately after the 3rd failure (no cooldown elapsed yet)", async () => {
    const { recordFailure, isBlocked } = await loadWith("jobtrackr-worker");
    await recordFailure("careerjet");
    await recordFailure("careerjet");
    await recordFailure("careerjet");
    expect(await isBlocked("careerjet")).toBe(true);
  });

  it("REGRESSION: opens a single probe window once PROBE_COOLDOWN_SECONDS has elapsed since the last failure — the fix for the never-clears bug", async () => {
    const { recordFailure, isBlocked } = await loadWith("jobtrackr-worker");
    await recordFailure("careerjet");
    await recordFailure("careerjet");
    await recordFailure("careerjet");
    expect(await isBlocked("careerjet")).toBe(true);

    // Just under an hour later — still blocked.
    mockNow += 60 * 60 - 1;
    expect(await isBlocked("careerjet")).toBe(true);

    // An hour after the last failure — probe window opens.
    mockNow += 1;
    expect(await isBlocked("careerjet")).toBe(false);
  });

  it("a failed probe re-blocks the source for another full cooldown window", async () => {
    const { recordFailure, isBlocked } = await loadWith("jobtrackr-worker");
    await recordFailure("careerjet");
    await recordFailure("careerjet");
    await recordFailure("careerjet");

    mockNow += 60 * 60; // probe window open
    expect(await isBlocked("careerjet")).toBe(false);

    // The orchestrator attempts the fetch, it fails again — recordFailure()
    // refreshes the TTL, resetting the cooldown clock.
    await recordFailure("careerjet");
    expect(await isBlocked("careerjet")).toBe(true);

    mockNow += 60 * 60 - 1;
    expect(await isBlocked("careerjet")).toBe(true);
    mockNow += 1;
    expect(await isBlocked("careerjet")).toBe(false);
  });

  it("a successful probe clears the counter entirely, not just for one cooldown window", async () => {
    const { recordFailure, recordSuccess, isBlocked } = await loadWith("jobtrackr-worker");
    await recordFailure("careerjet");
    await recordFailure("careerjet");
    await recordFailure("careerjet");

    mockNow += 60 * 60; // probe window open
    expect(await isBlocked("careerjet")).toBe(false);

    await recordSuccess("careerjet");
    expect(await isBlocked("careerjet")).toBe(false);

    // Confirmed fully cleared, not just "still within an open probe window" —
    // even far in the future (long past any cooldown), it's still unblocked
    // because the counter itself is gone.
    mockNow += 60 * 60 * 24 * 30;
    expect(await isBlocked("careerjet")).toBe(false);
  });
});

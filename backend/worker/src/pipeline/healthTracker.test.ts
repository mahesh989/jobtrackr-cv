import { describe, it, expect, beforeEach, vi } from "vitest";

// Health state lives in the SAME Upstash instance for local dev and production
// (.env.example points both at one URL), so these tests pin the property that
// keeps a local run from blocking a source in production: the Redis keys are
// namespaced per deployment via FLY_APP_NAME.

const store = new Map<string, string>();
vi.mock("../queue/connection.js", () => ({
  connection: {
    get:    vi.fn(async (k: string) => store.get(k) ?? null),
    del:    vi.fn(async (k: string) => { store.delete(k); }),
    incr:   vi.fn(async (k: string) => {
      const next = parseInt(store.get(k) ?? "0", 10) + 1;
      store.set(k, String(next));
      return next;
    }),
    expire: vi.fn(async () => 1),
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

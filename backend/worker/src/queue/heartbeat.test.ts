import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// In-memory stand-in for the ioredis client — enough SET/DEL to exercise
// the heartbeat's write/refresh/cleanup cycle without a live TTL clock.
const store = new Map<string, string>();
vi.mock("./connection.js", () => ({
  connection: {
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return "OK";
    }),
    del: vi.fn(async (key: string) => {
      const had = store.has(key);
      store.delete(key);
      return had ? 1 : 0;
    }),
  },
}));

const { startHeartbeat, HEARTBEAT_KEY_PREFIX } = await import("./heartbeat.js");

beforeEach(() => {
  vi.useFakeTimers();
  store.clear();
  delete process.env.FLY_MACHINE_ID;
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("startHeartbeat", () => {
  it("writes its key immediately using FLY_MACHINE_ID when set", async () => {
    process.env.FLY_MACHINE_ID = "784595ea63ee98";
    const hb = startHeartbeat();
    await vi.advanceTimersByTimeAsync(0);

    expect(hb.machineId).toBe("784595ea63ee98");
    expect(store.has(`${HEARTBEAT_KEY_PREFIX}784595ea63ee98`)).toBe(true);
    await hb.stop();
  });

  it("falls back to a pid-based id when FLY_MACHINE_ID is unset (local dev)", async () => {
    const hb = startHeartbeat();
    await vi.advanceTimersByTimeAsync(0);

    expect(hb.machineId).toBe(`local:${process.pid}`);
    await hb.stop();
  });

  it("refreshes the key on the timer without creating a second key", async () => {
    process.env.FLY_MACHINE_ID = "m1";
    const hb = startHeartbeat();
    await vi.advanceTimersByTimeAsync(0);
    const key = `${HEARTBEAT_KEY_PREFIX}m1`;
    const firstValue = store.get(key);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(store.size).toBe(1);
    expect(store.get(key)).not.toBe(firstValue); // timestamp advanced

    await hb.stop();
  });

  it("stop() deletes the key and halts further refreshes", async () => {
    process.env.FLY_MACHINE_ID = "m1";
    const hb = startHeartbeat();
    await vi.advanceTimersByTimeAsync(0);
    await hb.stop();

    expect(store.has(`${HEARTBEAT_KEY_PREFIX}m1`)).toBe(false);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(store.size).toBe(0); // no key resurrected by a stray timer
  });

  it("two concurrent machines get distinct keys — the signal the zombie check relies on", async () => {
    process.env.FLY_MACHINE_ID = "old-zombie";
    const hb1 = startHeartbeat();
    await vi.advanceTimersByTimeAsync(0);

    process.env.FLY_MACHINE_ID = "new-deploy";
    const hb2 = startHeartbeat();
    await vi.advanceTimersByTimeAsync(0);

    expect(store.size).toBe(2);
    expect([...store.keys()].sort()).toEqual(
      [`${HEARTBEAT_KEY_PREFIX}old-zombie`, `${HEARTBEAT_KEY_PREFIX}new-deploy`].sort()
    );

    await hb1.stop();
    await hb2.stop();
  });
});

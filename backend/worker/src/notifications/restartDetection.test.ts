import { describe, it, expect, beforeEach, vi } from "vitest";

// Minimal in-memory stand-in for the ioredis client — just enough of
// SET/GET/DEL to exercise the marker's presence/absence logic.
const store = new Map<string, string>();
vi.mock("../queue/connection.js", () => ({
  connection: {
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return "OK";
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    del: vi.fn(async (key: string) => {
      const had = store.has(key);
      store.delete(key);
      return had ? 1 : 0;
    }),
  },
}));

const { markExpectedShutdown, wasShutdownExpected } = await import("./restartDetection.js");

beforeEach(() => {
  store.clear();
});

describe("restartDetection", () => {
  it("reports the shutdown as unexpected when no marker was written", async () => {
    expect(await wasShutdownExpected()).toBe(false);
  });

  it("reports the shutdown as expected when markExpectedShutdown() ran first", async () => {
    await markExpectedShutdown();
    expect(await wasShutdownExpected()).toBe(true);
  });

  it("clears the marker after reading it, so a second check reverts to unexpected", async () => {
    await markExpectedShutdown();
    expect(await wasShutdownExpected()).toBe(true);
    expect(await wasShutdownExpected()).toBe(false);
  });
});

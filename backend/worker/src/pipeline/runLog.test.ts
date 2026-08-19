/**
 * Coverage gap (execution chunk C55b): runLog.ts had zero test coverage.
 * This file exists specifically to pin the wiring C55b adds —
 * finishRunLog() must flush logContext.ts's buffered log lines BEFORE
 * marking the run_logs row finished, so trailing console output from a
 * fast-finishing run isn't left sitting unflushed with no future
 * interval tick left to catch it (see logContext.test.ts for the
 * buffering/flush behaviour itself).
 */
import { describe, it, expect, vi } from "vitest";

const flushRunLogMock = vi.fn().mockResolvedValue(undefined);
vi.mock("./logContext.js", () => ({
  flushRunLog: (...args: unknown[]) => flushRunLogMock(...args),
}));

function fakeDb(updateError: { message: string } | null = null) {
  const calls: { table: string; update: Record<string, unknown>; eqCol: string; eqVal: string }[] = [];
  return {
    calls,
    db: {
      from(table: string) {
        let updatePayload: Record<string, unknown> = {};
        return {
          update(payload: Record<string, unknown>) {
            updatePayload = payload;
            return this;
          },
          eq(col: string, val: string) {
            calls.push({ table, update: updatePayload, eqCol: col, eqVal: val });
            return Promise.resolve({ error: updateError });
          },
        };
      },
    },
  };
}

describe("finishRunLog", () => {
  it("flushes buffered log lines before updating the run_logs row", async () => {
    const { db, calls } = fakeDb();
    vi.doMock("../db/client.js", () => ({ db }));
    vi.resetModules();
    const { finishRunLog } = await import("./runLog.js");

    const order: string[] = [];
    flushRunLogMock.mockImplementationOnce(async () => {
      order.push("flush");
    });

    await finishRunLog("run-1", {
      status: "completed",
      jobs_fetched: 1,
      jobs_after_dedup: 1,
      jobs_saved: 1,
      sources_run: ["seek"],
    });
    order.push("update");

    expect(flushRunLogMock).toHaveBeenCalledWith("run-1");
    expect(order).toEqual(["flush", "update"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ table: "run_logs", eqCol: "id", eqVal: "run-1" });
    expect(calls[0].update).toMatchObject({ status: "completed", jobs_saved: 1 });
  });

  it("still updates the row even when nothing was buffered (flushRunLog no-ops)", async () => {
    const { db, calls } = fakeDb();
    vi.doMock("../db/client.js", () => ({ db }));
    vi.resetModules();
    const { finishRunLog } = await import("./runLog.js");

    await finishRunLog("run-2", {
      status: "failed",
      jobs_fetched: 0,
      jobs_after_dedup: 0,
      jobs_saved: 0,
      sources_run: [],
      error_message: "boom",
    });

    expect(flushRunLogMock).toHaveBeenCalledWith("run-2");
    expect(calls).toHaveLength(1);
    expect(calls[0].update).toMatchObject({ status: "failed", error_message: "boom" });
  });

  it("C67: logs loudly instead of silently swallowing a failed terminal write", async () => {
    const { db } = fakeDb({ message: "connection reset" });
    vi.doMock("../db/client.js", () => ({ db }));
    vi.resetModules();
    const { finishRunLog } = await import("./runLog.js");

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await finishRunLog("run-3", {
      status: "completed",
      jobs_fetched: 1,
      jobs_after_dedup: 1,
      jobs_saved: 1,
      sources_run: ["seek"],
    });

    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("run-3"));
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("connection reset"));
    errSpy.mockRestore();
  });
});

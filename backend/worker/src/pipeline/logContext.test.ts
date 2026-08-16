/**
 * Regression tests for C55 (audit, execution chunk): logContext.ts's
 * console-mirroring RPC call is fire-and-forget with NO .catch() —
 * `void db.rpc(...).then(({ error }) => { if (error) origWarn(...) })`
 * only handles the RESOLVED-with-error case. If the promise itself
 * REJECTS (network exception, timeout, etc. — not the same as resolving
 * with a Postgrest `{error}` object), that rejection is unhandled.
 * `index.ts` registers `process.on("unhandledRejection", crashHandler)`
 * which calls `process.exit(1)` — so a single transient network blip
 * during a routine log write could crash the entire worker process
 * mid-run, not just fail one log line.
 *
 * C55b (this file's later additions): the original design fired one RPC
 * per console.log call, and append_run_log_line() re-writes the WHOLE
 * growing log_lines blob on every call — O(n²) over a run's lifetime.
 * logContext.ts now buffers lines per-run in-process and flushes them in
 * batches via append_run_log_lines(), either on a periodic interval or
 * when the run finishes (runLog.ts's finishRunLog(), see runLog.test.ts).
 *
 * logContext.ts monkeypatches console.log/warn/error as a MODULE-LEVEL
 * side effect at import time, so each test dynamically re-imports it
 * after vi.resetModules() (same pattern as careerjet.test.ts's
 * loadAdapter()) and restores the real console methods afterwards —
 * otherwise successive imports would wrap an already-wrapped console
 * and multiply RPC calls per test run.
 *
 * Fake timers are used throughout so the module-level flush interval
 * never fires on real wall-clock time during the test run (it would
 * otherwise leak across tests, since resetModules() doesn't clear
 * previously-scheduled intervals from earlier imports).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

let rpcImpl: (...args: unknown[]) => Promise<{ error: { message: string } | null }>;

vi.mock("../db/client.js", () => ({
  db: { rpc: (...args: unknown[]) => rpcImpl(...args) },
}));

const realLog = console.log;
const realWarn = console.warn;
const realError = console.error;

const FLUSH_INTERVAL_MS = 2_000;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  console.log = realLog;
  console.warn = realWarn;
  console.error = realError;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function loadLogContext() {
  vi.resetModules();
  return import("./logContext.js");
}

describe("logContext", () => {
  it("outside an active run scope, console calls are never buffered or mirrored", async () => {
    const calls: unknown[] = [];
    rpcImpl = (...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve({ error: null });
    };
    await loadLogContext();

    console.log("no active run");
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);

    expect(calls).toHaveLength(0);
  });

  it("inside an active run scope, console.log lines are buffered, not immediately RPC'd", async () => {
    const calls: unknown[] = [];
    rpcImpl = (...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve({ error: null });
    };
    const { runLogContext } = await loadLogContext();

    runLogContext.run({ runLogId: "run-1" }, () => {
      console.log("hello", "world");
    });
    // Yield one microtask turn without advancing fake time — no interval
    // tick has happened yet, so nothing should have been sent.
    await Promise.resolve();

    expect(calls).toHaveLength(0);
  });

  it("buffered lines are flushed together in one batched append_run_log_lines call once the interval elapses", async () => {
    const calls: unknown[] = [];
    rpcImpl = (...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve({ error: null });
    };
    const { runLogContext } = await loadLogContext();

    runLogContext.run({ runLogId: "run-1" }, () => {
      console.log("first");
      console.log("second");
    });
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);

    expect(calls).toHaveLength(1);
    const [fn, params] = calls[0] as [string, { rid: string; lines: { t: string; msg: string }[] }];
    expect(fn).toBe("append_run_log_lines");
    expect(params.rid).toBe("run-1");
    expect(params.lines.map((l) => l.msg)).toEqual(["first", "second"]);
    expect(typeof params.lines[0].t).toBe("string");
  });

  it("a second interval tick only sends lines emitted since the last flush, not a duplicate of the first batch", async () => {
    const calls: unknown[][] = [];
    rpcImpl = (...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve({ error: null });
    };
    const { runLogContext } = await loadLogContext();

    runLogContext.run({ runLogId: "run-1" }, () => console.log("first"));
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);

    runLogContext.run({ runLogId: "run-1" }, () => console.log("second"));
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);

    expect(calls).toHaveLength(2);
    const secondParams = calls[1][1] as { lines: { msg: string }[] };
    expect(secondParams.lines.map((l) => l.msg)).toEqual(["second"]);
  });

  it("lines from two concurrent runs are flushed as two separate batched calls, never mixed", async () => {
    const calls: unknown[][] = [];
    rpcImpl = (...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve({ error: null });
    };
    const { runLogContext } = await loadLogContext();

    runLogContext.run({ runLogId: "run-a" }, () => console.log("from a"));
    runLogContext.run({ runLogId: "run-b" }, () => console.log("from b"));
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);

    expect(calls).toHaveLength(2);
    const byRid = Object.fromEntries(
      calls.map((call) => {
        const p = call[1] as { rid: string; lines: { msg: string }[] };
        return [p.rid, p.lines.map((l) => l.msg)];
      }),
    );
    expect(byRid["run-a"]).toEqual(["from a"]);
    expect(byRid["run-b"]).toEqual(["from b"]);
  });

  describe("flushRunLog (explicit flush, used by runLog.ts's finishRunLog)", () => {
    it("sends buffered lines immediately, without waiting for the interval", async () => {
      const calls: unknown[] = [];
      rpcImpl = (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve({ error: null });
      };
      const { runLogContext, flushRunLog } = await loadLogContext();

      runLogContext.run({ runLogId: "run-1" }, () => console.log("trailing line"));
      await flushRunLog("run-1");

      expect(calls).toHaveLength(1);
    });

    it("is a no-op (no RPC call) when the run has no buffered lines", async () => {
      const calls: unknown[] = [];
      rpcImpl = (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve({ error: null });
      };
      const { flushRunLog } = await loadLogContext();

      await flushRunLog("run-with-nothing-buffered");

      expect(calls).toHaveLength(0);
    });

    it("clears the buffer, so a later interval tick does not resend the same lines", async () => {
      const calls: unknown[] = [];
      rpcImpl = (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve({ error: null });
      };
      const { runLogContext, flushRunLog } = await loadLogContext();

      runLogContext.run({ runLogId: "run-1" }, () => console.log("only line"));
      await flushRunLog("run-1");
      await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);

      expect(calls).toHaveLength(1);
    });
  });

  it("when the RPC resolves with a Postgrest {error}, the failure is reported via the ORIGINAL console.warn (not the patched one, to avoid re-triggering itself)", async () => {
    rpcImpl = () => Promise.resolve({ error: { message: "boom" } });

    // Install the spy as the "original" console.warn BEFORE importing —
    // logContext.ts captures `origWarn = console.warn` once, at import
    // time, so the spy must already be in place for it to be captured.
    const warnSpy = vi.fn();
    console.warn = warnSpy;
    const { runLogContext } = await loadLogContext();

    runLogContext.run({ runLogId: "run-1" }, () => {
      console.log("trigger");
    });
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[logContext] batched append failed: boom"),
    );
  });

  it("REGRESSION (C55): a REJECTED append_run_log_lines promise (network exception, not a resolved {error}) does not become an unhandled promise rejection that could crash the worker", async () => {
    rpcImpl = () => Promise.reject(new Error("network blip"));
    const { runLogContext } = await loadLogContext();

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    try {
      runLogContext.run({ runLogId: "run-1" }, () => {
        console.log("hello");
      });
      await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    expect(unhandled).toHaveLength(0);
  });

  it("a rejected RPC via the explicit flushRunLog() path also does not throw or reject", async () => {
    rpcImpl = () => Promise.reject(new Error("network blip"));
    const warnSpy = vi.fn();
    console.warn = warnSpy;
    const { runLogContext, flushRunLog } = await loadLogContext();

    runLogContext.run({ runLogId: "run-1" }, () => console.log("hello"));

    await expect(flushRunLog("run-1")).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[logContext] batched append threw: network blip"),
    );
  });
});

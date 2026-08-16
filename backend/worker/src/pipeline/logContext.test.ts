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
 * logContext.ts monkeypatches console.log/warn/error as a MODULE-LEVEL
 * side effect at import time, so each test dynamically re-imports it
 * after vi.resetModules() (same pattern as careerjet.test.ts's
 * loadAdapter()) and restores the real console methods afterwards —
 * otherwise successive imports would wrap an already-wrapped console
 * and multiply RPC calls per test run.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

let rpcImpl: (...args: unknown[]) => Promise<{ error: { message: string } | null }>;

vi.mock("../db/client.js", () => ({
  db: { rpc: (...args: unknown[]) => rpcImpl(...args) },
}));

const realLog = console.log;
const realWarn = console.warn;
const realError = console.error;

afterEach(() => {
  console.log = realLog;
  console.warn = realWarn;
  console.error = realError;
  vi.restoreAllMocks();
});

async function loadLogContext() {
  vi.resetModules();
  return import("./logContext.js");
}

describe("logContext", () => {
  it("outside an active run scope, console calls are never mirrored to Postgres", async () => {
    const calls: unknown[] = [];
    rpcImpl = (...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve({ error: null });
    };
    await loadLogContext();

    console.log("no active run");
    await new Promise((r) => setTimeout(r, 10));

    expect(calls).toHaveLength(0);
  });

  it("inside an active run scope, each console.log mirrors exactly one append_run_log_line RPC call with the {t, msg} shape", async () => {
    const calls: unknown[] = [];
    rpcImpl = (...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve({ error: null });
    };
    const { runLogContext } = await loadLogContext();

    runLogContext.run({ runLogId: "run-1" }, () => {
      console.log("hello", "world");
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(calls).toHaveLength(1);
    const [fn, params] = calls[0] as [string, { rid: string; line: { t: string; msg: string } }];
    expect(fn).toBe("append_run_log_line");
    expect(params.rid).toBe("run-1");
    expect(params.line.msg).toBe("hello world");
    expect(typeof params.line.t).toBe("string");
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
    await new Promise((r) => setTimeout(r, 10));

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[logContext] append failed: boom"),
    );
  });

  it("REGRESSION (C55): a REJECTED append_run_log_line promise (network exception, not a resolved {error}) does not become an unhandled promise rejection that could crash the worker", async () => {
    rpcImpl = () => Promise.reject(new Error("network blip"));
    const { runLogContext } = await loadLogContext();

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    try {
      runLogContext.run({ runLogId: "run-1" }, () => {
        console.log("hello");
      });
      // Let the fire-and-forget promise chain settle across several
      // microtask/macrotask turns — Node fires "unhandledRejection"
      // asynchronously, not synchronously on rejection.
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    expect(unhandled).toHaveLength(0);
  });
});

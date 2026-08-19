// Per-run log capture.
//
// We patch console.log / console.error globally once at module load.
// Inside an active runLogContext.run() scope, each call is forwarded to
// the original method AND buffered in-process, flushed to run_logs.log_lines
// in batches via the append_run_log_lines() Postgres function (C55b).
// Outside the scope (worker startup, scheduler ticks, etc.) the original
// behaviour is unchanged.
//
// Buffering, not one RPC per line: append_run_log_lines() (like its
// single-line predecessor, append_run_log_line()) does a full
// read-modify-write of the WHOLE growing log_lines jsonb blob on every
// call. Batching lines into one call per FLUSH_INTERVAL_MS (or per run
// finish, whichever comes first) cuts the RPC count — and therefore the
// re-write volume — by roughly the batch size, without changing the
// underlying O(n²) shape (see C55c for the actual O(1) redesign).
//
// AsyncLocalStorage threads the runLogId through any await chain spawned
// from the pipeline call, so adapter-level logs are captured without
// having to plumb runLogId through every function signature.

import { AsyncLocalStorage } from "node:async_hooks";
import { db } from "../db/client.js";

interface RunCtx { runLogId: string }
interface LogLine { t: string; msg: string }

export const runLogContext = new AsyncLocalStorage<RunCtx>();

const origLog   = console.log;
const origWarn  = console.warn;
const origError = console.error;

const FLUSH_INTERVAL_MS = 2_000;
const buffers = new Map<string, LogLine[]>();

function stringify(args: unknown[]): string {
  return args
    .map((a) => (typeof a === "string" ? a : a instanceof Error ? a.message : JSON.stringify(a)))
    .join(" ");
}

function emit(msg: string): void {
  const ctx = runLogContext.getStore();
  if (!ctx) return;
  const line: LogLine = { t: new Date().toISOString(), msg };
  const existing = buffers.get(ctx.runLogId);
  if (existing) existing.push(line);
  else buffers.set(ctx.runLogId, [line]);
}

// Flushes one run's buffered lines via a single batched RPC. Exported so
// runLog.ts's finishRunLog() can await it directly before marking the run
// finished — otherwise trailing lines emitted just before a fast run
// completes could still be sitting unflushed in the buffer when the
// run_logs row is updated, and the periodic interval below might not tick
// again in time to catch them.
//
// Never throws — same fire-and-forget-safe contract as the pre-C55b code
// (a REJECTED promise here must not become an unhandled rejection, which
// index.ts's crash handler would turn into a full worker process exit).
export async function flushRunLog(runLogId: string): Promise<void> {
  const lines = buffers.get(runLogId);
  if (!lines || lines.length === 0) return;
  // Clear BEFORE the await: a line emitted while this RPC is in flight
  // must start a fresh buffer, not be lost or double-sent on the next
  // flush.
  buffers.delete(runLogId);
  try {
    const { error } = await db.rpc("append_run_log_lines", { rid: runLogId, lines });
    if (error) origWarn(`[logContext] batched append failed: ${error.message}`);
  } catch (err) {
    origWarn(`[logContext] batched append threw: ${err instanceof Error ? err.message : err}`);
  }
}

setInterval(() => {
  for (const runLogId of buffers.keys()) {
    void flushRunLog(runLogId);
  }
}, FLUSH_INTERVAL_MS).unref();

console.log   = (...args: unknown[]) => { origLog(...args);   emit(stringify(args)); };
console.warn  = (...args: unknown[]) => { origWarn(...args);  emit(stringify(args)); };
console.error = (...args: unknown[]) => { origError(...args); emit(stringify(args)); };

// Per-run log capture.
//
// We patch console.log / console.error globally once at module load.
// Inside an active runLogContext.run() scope, each call is forwarded to
// the original method AND fired-and-forgotten to run_logs.log_lines via
// the append_run_log_line() Postgres function. Outside the scope (worker
// startup, scheduler ticks, etc.) the original behaviour is unchanged.
//
// AsyncLocalStorage threads the runLogId through any await chain spawned
// from the pipeline call, so adapter-level logs are captured without
// having to plumb runLogId through every function signature.

import { AsyncLocalStorage } from "node:async_hooks";
import { db } from "../db/client.js";

interface RunCtx { runLogId: string }

export const runLogContext = new AsyncLocalStorage<RunCtx>();

const origLog   = console.log;
const origWarn  = console.warn;
const origError = console.error;

function stringify(args: unknown[]): string {
  return args
    .map((a) => (typeof a === "string" ? a : a instanceof Error ? a.message : JSON.stringify(a)))
    .join(" ");
}

function emit(msg: string): void {
  const ctx = runLogContext.getStore();
  if (!ctx) return;
  const line = { t: new Date().toISOString(), msg };
  // Fire-and-forget — never block the pipeline on a log write.
  void db.rpc("append_run_log_line", { rid: ctx.runLogId, line }).then(({ error }) => {
    if (error) origWarn(`[logContext] append failed: ${error.message}`);
  });
}

console.log   = (...args: unknown[]) => { origLog(...args);   emit(stringify(args)); };
console.warn  = (...args: unknown[]) => { origWarn(...args);  emit(stringify(args)); };
console.error = (...args: unknown[]) => { origError(...args); emit(stringify(args)); };

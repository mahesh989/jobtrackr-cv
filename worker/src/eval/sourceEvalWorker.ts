// BullMQ Worker that processes source_eval jobs.
//
// Booted from worker/src/index.ts alongside the main pipeline Worker.
// Concurrency is intentionally > 1 — none of the 6 eval sources spawn a
// Playwright Chromium, so the memory pressure that forces the main worker
// to concurrency=1 doesn't apply here.
//
// On every job:
//   1. Mark results.<source> = { status: "running" } on source_eval_runs
//   2. Run the eval (fetch → filter → dedup → JD enrich)
//   3. Patch results.<source> with the final result
//   4. If every requested source is now done|error, compute the cross-source
//      overlap matrix + unique_total, then mark the row 'completed'.

import { Worker } from "bullmq";
import { connection } from "../queue/connection.js";
import { db } from "../db/client.js";
import { SOURCE_EVAL_QUEUE, type SourceEvalJobData } from "./sourceEvalQueue.js";
import { runSourceEval, type SourceEvalResult } from "./sourceEval.js";

// 3 in flight is safe: HTTP-only adapters (Adzuna/Careerjet/Greenhouse/Lever)
// + SEEK direct (got-scraping) are small memory footprints. Apify runs are
// remote — local cost is negligible.
const CONCURRENCY = 3;

interface EvalRow {
  id:                 string;
  sources_requested:  string[];
  results:            Record<string, SourceEvalResult | { status: "running" | "pending"; started_at?: string }>;
}

async function patchResults(
  evalId: string,
  patch:  Record<string, unknown>,
): Promise<EvalRow | null> {
  // Read-modify-write on the jsonb. BullMQ doesn't dispatch two jobs for the
  // same {evalId, source} so there's no write-skew within a single eval.
  const { data: row } = await db
    .from("source_eval_runs")
    .select("id, sources_requested, results")
    .eq("id", evalId)
    .maybeSingle();
  if (!row) return null;
  const merged = { ...(row.results as Record<string, unknown> ?? {}), ...patch };
  const { data: updated } = await db
    .from("source_eval_runs")
    .update({ results: merged })
    .eq("id", evalId)
    .select("id, sources_requested, results")
    .maybeSingle();
  return updated as EvalRow | null;
}

function isTerminal(entry: unknown): entry is SourceEvalResult {
  return !!entry
    && typeof entry === "object"
    && "status" in (entry as Record<string, unknown>)
    && ((entry as { status: string }).status === "done"
        || (entry as { status: string }).status === "error");
}

async function maybeFinalize(evalId: string): Promise<void> {
  const { data: row } = await db
    .from("source_eval_runs")
    .select("id, sources_requested, results")
    .eq("id", evalId)
    .maybeSingle();
  if (!row) return;

  const requested: string[] = row.sources_requested as string[];
  const results = row.results as Record<string, SourceEvalResult | { status: string }>;

  const allTerminal = requested.every((s) => isTerminal(results[s]));
  if (!allTerminal) return;

  // Build overlap matrix: url_hash → [sources, ...]
  const overlap: Record<string, string[]> = {};
  for (const src of requested) {
    const r = results[src];
    if (!isTerminal(r)) continue;
    for (const h of r.kept_url_hashes ?? []) {
      if (!overlap[h]) overlap[h] = [];
      overlap[h].push(src);
    }
  }
  const unique_total = Object.keys(overlap).length;

  // Failure-policy: completed only if at least one source finished cleanly.
  // Otherwise mark failed (every requested source errored out).
  const anyDone = requested.some((s) => {
    const r = results[s];
    return isTerminal(r) && r.status === "done";
  });

  await db
    .from("source_eval_runs")
    .update({
      status:        anyDone ? "completed" : "failed",
      overlap,
      unique_total,
      finished_at:   new Date().toISOString(),
    })
    .eq("id", evalId);

  console.log(`[source-eval] finalized eval ${evalId} — ${unique_total} unique across ${requested.length} sources`);
}

export function startSourceEvalWorker(): Worker<SourceEvalJobData> {
  const worker = new Worker<SourceEvalJobData>(
    SOURCE_EVAL_QUEUE,
    async (job) => {
      const { evalId, userId, source } = job.data;
      console.log(`[source-eval] job ${job.id} — eval=${evalId} source=${source}`);

      await patchResults(evalId, {
        [source]: { status: "running", started_at: new Date().toISOString() },
      });

      const result = await runSourceEval(job.data);

      await patchResults(evalId, { [source]: result });
      await maybeFinalize(evalId);

      console.log(`[source-eval] done — eval=${evalId} source=${source} status=${result.status}`);
      return { ok: true };
    },
    { connection, concurrency: CONCURRENCY },
  );

  worker.on("failed", async (job, err) => {
    if (!job) return;
    console.error(`[source-eval] job ${job.id} failed:`, err.message);
    const { source, evalId } = job.data;
    await patchResults(evalId, {
      [source]: {
        status:      "error",
        error:       err.message,
        started_at:  new Date().toISOString(),
        finished_at: new Date().toISOString(),
        timing_ms:   { fetch: 0, dedup: 0, jd_enrich: 0 },
        counts: {
          fetched: 0, after_url_dedup: 0, after_keyword: 0,
          after_smart: 0, after_dedup: 0, would_save: 0, full_jd: 0, thin_jd: 0,
        },
        samples: [],
        kept_url_hashes: [],
      },
    });
    await maybeFinalize(evalId);
  });

  console.log(`[source-eval] worker started — queue=${SOURCE_EVAL_QUEUE} concurrency=${CONCURRENCY}`);
  return worker;
}

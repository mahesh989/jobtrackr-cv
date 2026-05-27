// BullMQ queue + connection for the source-eval beta tool.
//
// Lives on a SEPARATE queue from the main pipeline so:
//   1. concurrency can be > 1 (these 6 sources don't use Playwright)
//   2. an eval run can never starve / interfere with real profile runs.

import { Queue } from "bullmq";
import { Redis } from "ioredis";
import type { EvalSourceKey } from "./sourceEval.js";

export const SOURCE_EVAL_QUEUE = "jobtrackr-source-eval";

export interface SourceEvalJobData {
  evalId:           string;
  userId:           string;
  source:           EvalSourceKey;
  keywords:         string[];
  location:         string;
  postedWithinDays: number;
  // Optional radius (km) for Adzuna. Ignored by other adapters.
  distanceKm?:      number;
  // Optional smart filter — keep only jobs whose title (or title+description,
  // depending on filterScope) contains any of these phrases. Applied locally
  // after the source's own search.
  mustInclude?:     string[];
  // Filter match scope. 'title' (default, cleanest) or 'title+description'.
  filterScope?:     "title" | "title+description";
}

// Lazy connection — web app reuses this module from its API routes. Building
// the Redis client at module-load time would crash any web request that
// happens to import this file before REDIS_URL is wired up in the env.
let _queue: Queue<SourceEvalJobData> | null = null;
export function getSourceEvalQueue(): Queue<SourceEvalJobData> {
  if (_queue) return _queue;
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL is required");
  const connection = new Redis(url, {
    maxRetriesPerRequest: null,
    tls: url.startsWith("rediss://") || url.includes("upstash.io") ? {} : undefined,
  });
  _queue = new Queue<SourceEvalJobData>(SOURCE_EVAL_QUEUE, { connection });
  return _queue;
}

// POST /api/source-eval/start
//
// Body: { keywords: string[], location: string, postedWithinDays: number, sources: string[] }
//
// Creates a source_eval_runs row, enqueues one BullMQ job per source onto
// the jobtrackr-source-eval queue, returns { id }. The client then polls
// /api/source-eval/[id] until status = "completed" | "failed".
//
// Dry-run only — the worker never writes to the jobs table.

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { rateLimit, RATE_LIMIT_MESSAGE } from "@/lib/rateLimit";

const QUEUE = "jobtrackr-source-eval";

// Whitelist — must match EvalSourceKey in worker/src/eval/sourceEval.ts.
// New sources require a worker change, so we don't accept arbitrary strings.
const SUPPORTED = new Set([
  "adzuna",
  "seek_direct",
  "seek_apify",
  "careerjet",
  "greenhouse",
  "lever",
]);

function getQueue() {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL is required");
  const connection = new Redis(url, {
    maxRetriesPerRequest: null,
    tls: url.startsWith("rediss://") ? {} : undefined,
    connectTimeout: 5000,
    retryStrategy: () => null,
  });
  return new Queue(QUEUE, { connection });
}

interface StartBody {
  keywords?:         unknown;
  location?:         unknown;
  postedWithinDays?: unknown;
  sources?:          unknown;
  distanceKm?:       unknown;
  mustInclude?:      unknown;
  filterScope?:      unknown;
}

export async function POST(request: NextRequest) {
  const cookieStore = await cookies();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase: ReturnType<typeof createServerClient<any>> = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (cookiesToSet) =>
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          ),
      },
    }
  );

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // 5 evals per minute. Each eval enqueues up to 6 jobs, and Adzuna/SEEK
  // direct cost is non-zero (rate-limit headers, residential proxy budget).
  const rl = await rateLimit(`source-eval:${user.id}`, 5, 60);
  if (!rl.allowed) {
    return NextResponse.json({ error: RATE_LIMIT_MESSAGE }, { status: 429 });
  }

  const body = (await request.json().catch(() => ({}))) as StartBody;

  const keywords = Array.isArray(body.keywords)
    ? body.keywords.filter((k): k is string => typeof k === "string" && k.trim().length > 0)
    : [];
  const location = typeof body.location === "string" ? body.location.trim() : "";
  const postedWithinDays = typeof body.postedWithinDays === "number"
    && Number.isInteger(body.postedWithinDays)
    && body.postedWithinDays >= 1 && body.postedWithinDays <= 60
      ? body.postedWithinDays
      : 14;
  const sources = Array.isArray(body.sources)
    ? body.sources.filter((s): s is string => typeof s === "string" && SUPPORTED.has(s))
    : [];
  const distanceKm = typeof body.distanceKm === "number"
    && Number.isFinite(body.distanceKm)
    && body.distanceKm >= 1 && body.distanceKm <= 500
      ? Math.round(body.distanceKm)
      : 50;
  const mustInclude = Array.isArray(body.mustInclude)
    ? body.mustInclude
        .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
        .slice(0, 20)
    : [];
  const filterScope = body.filterScope === "title+description"
    ? "title+description"
    : "title";

  if (keywords.length === 0) {
    return NextResponse.json({ error: "At least one keyword is required." }, { status: 400 });
  }
  if (sources.length === 0) {
    return NextResponse.json({ error: "At least one source is required." }, { status: 400 });
  }

  // Seed each source's slot with status:pending so the UI can render the
  // grid immediately instead of waiting for the worker to claim each job.
  const seededResults: Record<string, { status: "pending" }> = {};
  for (const s of sources) seededResults[s] = { status: "pending" };

  const { data: row, error: insertErr } = await supabase
    .from("source_eval_runs")
    .insert({
      user_id:            user.id,
      keywords,
      location: location || null,
      posted_within_days: postedWithinDays,
      sources_requested:  sources,
      status:             "running",
      results:            seededResults,
    })
    .select("id")
    .single();

  if (insertErr || !row) {
    console.error("[source-eval/start] insert failed:", insertErr?.message);
    return NextResponse.json({ error: "Failed to start eval." }, { status: 500 });
  }

  // Enqueue one job per source. If Redis is down we don't want a half-spawned
  // eval sitting in 'running' forever, so we wrap the whole batch in a try/catch
  // and mark the row failed on enqueue failure.
  let queue: Queue | null = null;
  try {
    queue = getQueue();
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Redis connection timeout")), 5000)
    );
    await Promise.race([
      Promise.all(sources.map((source) =>
        queue!.add(
          "source_eval",
          {
            evalId:           row.id,
            userId:           user.id,
            source,
            keywords,
            location,
            postedWithinDays,
            distanceKm,
            mustInclude,
            filterScope,
          },
          { attempts: 1 },     // one shot — surfacing the error matters more than retry here
        )
      )),
      timeoutPromise,
    ]);
    await queue.close();
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error("[source-eval/start] enqueue failed:", errorMsg);
    if (queue) await queue.close().catch(() => {});
    await supabase
      .from("source_eval_runs")
      .update({ status: "failed", finished_at: new Date().toISOString() })
      .eq("id", row.id);
    return NextResponse.json({ error: `Failed to enqueue eval: ${errorMsg}` }, { status: 500 });
  }

  return NextResponse.json({ id: row.id });
}

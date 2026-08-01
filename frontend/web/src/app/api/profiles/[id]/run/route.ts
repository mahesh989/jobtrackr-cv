import { NextRequest, NextResponse } from "next/server";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { rateLimit, RATE_LIMIT_MESSAGE } from "@/lib/rateLimit";
import { consumeRun } from "@/lib/billing/entitlements";
import { jsonError, withUser } from "@/lib/api-utils";

const QUEUE_NAME = "jobtrackr-pipeline";

function getQueue() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error("REDIS_URL is required");
  const connection = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    tls: {}, // Enable TLS for Upstash
    connectTimeout: 5000,
    retryStrategy: () => null, // Don't retry on connection failure
  });
  return new Queue(QUEUE_NAME, { connection });
}

export const POST = withUser(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
, { user, supabase }) => {
  const { id: profileId } = await params;

  // Optional { fullRefresh: true } body → re-run the deep 28-day window even on
  // an established profile (the UI "Full refresh" action). Default false.
  let fullRefresh = false;
  try {
    const body = await request.json();
    fullRefresh = body?.fullRefresh === true;
  } catch { /* no body → incremental */ }

  // Rate limit: each run enqueues a pipeline job that can incur Apify cost.
  const rl = await rateLimit(`run:${user.id}`, 10, 60);
  if (!rl.allowed) return jsonError(RATE_LIMIT_MESSAGE, 429);

  // Verify profile belongs to this user
  const { data: profile } = await supabase
    .from("search_profiles")
    .select("id, is_manual")
    .eq("id", profileId)
    .eq("user_id", user.id)
    .single();

  if (!profile) {
    return jsonError("Profile not found", 404);
  }

  // "Saved Jobs" (is_manual=true) is a container for manually-added jobs,
  // never a real search — the worker never fetches for it. The UI hides the
  // Run button for it, but that's client-side only; enforce it here too so
  // no other path (a stale button, a direct call) can enqueue a pointless —
  // and potentially very expensive — run against an empty-criteria profile.
  if (profile.is_manual) {
    return jsonError("This profile can't be run — it's for manually-added jobs only", 400);
  }

  // Billing gate: read-only accounts blocked; run quota metered per period.
  const gate = await consumeRun(user.id);
  if (!gate.allowed) {
    return NextResponse.json(
      { error: "Run limit reached", reason: gate.reason },
      { status: 402 },
    );
  }

  // Enqueue the pipeline job with timeout
  try {
    const queue = getQueue();

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Redis connection timeout")), 5000)
    );

    const job = await Promise.race([
      queue.add(
        "run_profile",
        { type: "run_profile", profileId, trigger: "manual", fullRefresh },
        { attempts: 3, backoff: { type: "exponential", delay: 5000 } }
      ),
      timeoutPromise
    ]);

    await queue.close();
    return NextResponse.json({ ok: true, jobId: job.id });
  } catch (err) {
    console.error("[run] enqueue failed:", err instanceof Error ? err.message : String(err));
    return jsonError("Failed to start run. Please try again.", 500);
  }
});

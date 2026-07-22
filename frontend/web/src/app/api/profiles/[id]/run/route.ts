import { NextRequest, NextResponse } from "next/server";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { createClient } from "@/lib/supabase/server";
import { rateLimit, RATE_LIMIT_MESSAGE } from "@/lib/rateLimit";
import { consumeRun } from "@/lib/billing/entitlements";

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

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: profileId } = await params;

  // Optional { fullRefresh: true } body → re-run the deep 28-day window even on
  // an established profile (the UI "Full refresh" action). Default false.
  let fullRefresh = false;
  try {
    const body = await request.json();
    fullRefresh = body?.fullRefresh === true;
  } catch { /* no body → incremental */ }

  // Auth check
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Rate limit: each run enqueues a pipeline job that can incur Apify cost.
  const rl = await rateLimit(`run:${user.id}`, 10, 60);
  if (!rl.allowed) return NextResponse.json({ error: RATE_LIMIT_MESSAGE }, { status: 429 });

  // Verify profile belongs to this user
  const { data: profile } = await supabase
    .from("search_profiles")
    .select("id")
    .eq("id", profileId)
    .eq("user_id", user.id)
    .single();

  if (!profile) {
    return NextResponse.json({ error: "Profile not found" }, { status: 404 });
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
    return NextResponse.json({ error: "Failed to start run. Please try again." }, { status: 500 });
  }
}

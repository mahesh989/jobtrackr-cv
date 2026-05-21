import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { Queue } from "bullmq";
import { Redis } from "ioredis";

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
  console.log("[run] POST called");
  const { id: profileId } = await params;
  console.log("[run] profileId:", profileId);

  // Auth check
  const cookieStore = await cookies();
  console.log("[run] cookieStore ready");
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
  console.log("[run] user:", user?.id);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Verify profile belongs to this user
  const { data: profile } = await supabase
    .from("search_profiles")
    .select("id")
    .eq("id", profileId)
    .eq("user_id", user.id)
    .single();
  console.log("[run] profile:", profile?.id);

  if (!profile) {
    return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  }

  console.log("[run] about to create queue");
  // Enqueue the pipeline job with timeout
  try {
    console.log("[run] creating queue...");
    const queue = getQueue();
    console.log("[run] queue created, adding job...");

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Redis connection timeout")), 5000)
    );

    const job = await Promise.race([
      queue.add(
        "run_profile",
        { type: "run_profile", profileId, trigger: "manual" },
        { attempts: 3, backoff: { type: "exponential", delay: 5000 } }
      ),
      timeoutPromise
    ]);
    console.log("[run] job added:", job.id);

    await queue.close();
    console.log("[run] queue closed");
    return NextResponse.json({ ok: true, jobId: job.id });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to enqueue";
    console.log("[run] error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

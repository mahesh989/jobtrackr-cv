import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { Queue } from "bullmq";
import { Redis } from "ioredis";

const QUEUE_NAME = "jobtrackr-pipeline";

function getQueue() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error("REDIS_URL is required");
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  return new Queue(QUEUE_NAME, { connection });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: profileId } = await params;

  // Auth check
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

  if (!profile) {
    return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  }

  // Enqueue the pipeline job
  try {
    const queue = getQueue();
    const job = await queue.add(
      "run_profile",
      { type: "run_profile", profileId, trigger: "manual" },
      { attempts: 3, backoff: { type: "exponential", delay: 5000 } }
    );
    await queue.close();
    return NextResponse.json({ ok: true, jobId: job.id });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to enqueue";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

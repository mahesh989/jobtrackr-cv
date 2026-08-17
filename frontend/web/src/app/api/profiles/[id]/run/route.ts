import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { rateLimit, RATE_LIMIT_MESSAGE } from "@/lib/rateLimit";
import {
  commitRunUsageEvent,
  consumeRun,
} from "@/lib/billing/entitlements";
import { jsonError, withUser } from "@/lib/api-utils";

const QUEUE_NAME = "jobtrackr-pipeline";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function getQueue() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error("REDIS_URL is required");
  const connection = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    tls: {}, // Enable TLS for Upstash
    connectTimeout: 5000,
    commandTimeout: 5000,
    retryStrategy: () => null, // Don't retry on connection failure
  });
  try {
    return { queue: new Queue(QUEUE_NAME, { connection }), connection };
  } catch (err) {
    connection.disconnect();
    throw err;
  }
}

export const POST = withUser(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
, { user, supabase }) => {
  const { id: profileId } = await params;

  // Optional { fullRefresh: true } body → re-run the deep 28-day window even on
  // an established profile (the UI "Full refresh" action). Default false.
  let fullRefresh = false;
  let requestId = randomUUID();
  try {
    const body = await request.json();
    fullRefresh = body?.fullRefresh === true;
    if (body?.requestId !== undefined) {
      if (typeof body.requestId !== "string" || !UUID_RE.test(body.requestId)) {
        return jsonError("Invalid run request ID", 400);
      }
      requestId = body.requestId.toLowerCase();
    }
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

  // BullMQ acknowledgement loss is ambiguous: Redis may have created the job
  // even when add() rejects. A stable browser request UUID is therefore both
  // the BullMQ job id and the idempotency key for the usage reservation.
  let resources: ReturnType<typeof getQueue> | null = null;
  try {
    resources = getQueue();
    const { queue } = resources;
    const queueJobId = `run-${user.id}-${requestId}`;

    const existing = await queue.getJob(queueJobId);
    if (existing) {
      const data = existing.data as {
        type?: string;
        profileId?: string;
        userId?: string;
        usageEventId?: string;
        fullRefresh?: boolean;
      };
      if (data.type !== "run_profile" || data.profileId !== profileId || data.userId !== user.id
        || data.fullRefresh !== fullRefresh) {
        return jsonError("Run request ID is already in use", 409);
      }
      const state = await existing.getState();
      if (state === "failed") {
        if (!existing.failedReason?.startsWith("run usage commit failed:")) {
          return NextResponse.json(
            { error: "The previous run failed. Retry to start a new run.", resetRequest: true },
            { status: 409 },
          );
        }
        if (data.usageEventId) await commitRunUsageEvent(data.usageEventId);
        await existing.retry("failed", {
          resetAttemptsMade: true,
          resetAttemptsStarted: true,
        });
        return NextResponse.json({ ok: true, jobId: existing.id });
      }
      if (data.usageEventId) {
        try {
          await commitRunUsageEvent(data.usageEventId);
        } catch (commitErr) {
          console.error(
            "[run] usage commit retry failed:",
            commitErr instanceof Error ? commitErr.message : String(commitErr),
          );
        }
      }
      return NextResponse.json({ ok: true, jobId: existing.id });
    }

    // Billing gate: read-only accounts blocked; run quota metered per period.
    const gate = await consumeRun(user.id, requestId, profileId, fullRefresh);
    if (!gate.allowed) {
      if (gate.requestConflict) {
        return NextResponse.json(
          { error: "Run request ID is already in use", resetRequest: true },
          { status: 409 },
        );
      }
      return NextResponse.json(
        { error: "Run limit reached", reason: gate.reason },
        { status: 402 },
      );
    }
    if (gate.alreadyCommitted) {
      return NextResponse.json({ ok: true, jobId: queueJobId, alreadyProcessed: true });
    }

    const job = await queue.add(
      "run_profile",
      {
        type: "run_profile",
        profileId,
        userId: user.id,
        usageEventId: gate.eventId,
        trigger: "manual",
        fullRefresh,
      },
      {
        jobId: queueJobId,
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
      },
    );

    // A duplicate add returns the already-existing job. Re-read its stored
    // payload before charging this request; BullMQ does not replace job data.
    const confirmed = await queue.getJob(queueJobId);
    const confirmedData = confirmed?.data as {
      type?: string;
      profileId?: string;
      userId?: string;
      usageEventId?: string;
      fullRefresh?: boolean;
    } | undefined;
    if (!confirmed || confirmedData?.type !== "run_profile"
      || confirmedData.profileId !== profileId || confirmedData.userId !== user.id
      || confirmedData.usageEventId !== gate.eventId
      || confirmedData.fullRefresh !== fullRefresh) {
      throw new Error("queued run could not be reconciled to its reservation");
    }

    if (gate.eventId) {
      try {
        await commitRunUsageEvent(gate.eventId);
      } catch (commitErr) {
        // The worker repeats this write before starting the paid pipeline.
        console.error(
          "[run] usage commit failed after enqueue:",
          commitErr instanceof Error ? commitErr.message : String(commitErr),
        );
      }
    }
    return NextResponse.json({ ok: true, jobId: confirmed.id ?? job.id });
  } catch (err) {
    console.error("[run] enqueue failed:", err instanceof Error ? err.message : String(err));
    // Keep any pending reservation: queue.add may have succeeded server-side.
    // Retry with this same id reconciles the job and reuses the reservation.
    return NextResponse.json(
      { error: "Run start is uncertain. Please retry.", requestId },
      { status: 503 },
    );
  } finally {
    if (resources) {
      try {
        await resources.queue.close();
      } catch (closeErr) {
        console.error(
          "[run] queue close failed:",
          closeErr instanceof Error ? closeErr.message : String(closeErr),
        );
      }
      try {
        await resources.connection.quit();
      } catch (quitErr) {
        resources.connection.disconnect();
        console.error(
          "[run] Redis quit failed:",
          quitErr instanceof Error ? quitErr.message : String(quitErr),
        );
      }
    }
  }
});

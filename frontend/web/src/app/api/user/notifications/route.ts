import { NextRequest, NextResponse } from "next/server";
import { withUser } from "@/lib/api-utils";

/**
 * GET/PATCH /api/user/notifications — the "email me when new jobs are found"
 * preference (user_engagement.notify_new_jobs). Uses the caller's own
 * Supabase client (RLS own-read / own-update) — no admin client needed here.
 */

export const GET = withUser(async (_req, _ctx, { user, supabase }) => {

  const { data } = await supabase
    .from("user_engagement")
    .select("notify_new_jobs")
    .eq("user_id", user.id)
    .maybeSingle();

  // Row may not exist yet (user pre-dates the touch RPC / migration 079
  // backfill only covers users existing at migration time) — default true.
  const notifyNewJobs = (data?.notify_new_jobs as boolean | undefined) ?? true;
  return NextResponse.json({ notify_new_jobs: notifyNewJobs });
});

export const PATCH = withUser(async (request: NextRequest, _ctx, { user, supabase }) => {

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const notifyNewJobs = (body as { notify_new_jobs?: unknown })?.notify_new_jobs;
  if (typeof notifyNewJobs !== "boolean") {
    return NextResponse.json({ error: "notify_new_jobs must be a boolean" }, { status: 400 });
  }

  // user_engagement has no user INSERT policy (row creation is meant to go
  // through the SECURITY DEFINER touch_user_engagement() RPC or the
  // migration backfill) — only own-read/own-update. So: ensure the row
  // exists via the RPC first (no-op if already fresh, but always creates it
  // when missing), then UPDATE the preference, which own-update permits.
  await supabase.rpc("touch_user_engagement");

  const { error } = await supabase
    .from("user_engagement")
    .update({ notify_new_jobs: notifyNewJobs, updated_at: new Date().toISOString() })
    .eq("user_id", user.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ notify_new_jobs: notifyNewJobs });
});

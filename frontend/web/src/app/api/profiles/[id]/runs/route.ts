import { createAdminClient } from "@/lib/supabase/admin";
import { NextResponse }      from "next/server";
import { withUser } from "@/lib/api-utils";

export const GET = withUser(async (
  req: Request,
  { params }: { params: Promise<{ id: string }> }, { user, supabase }) => {
  const { id } = await params;
  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status");


  // Explicit ownership check (defence-in-depth on top of run_logs RLS) — keeps
  // this route consistent with its DELETE handler and the per-run logs route.
  const { data: profile } = await supabase
    .from("search_profiles")
    .select("id")
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!profile) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let query = supabase.from("run_logs").select("id, status, current_stage, started_at").eq("profile_id", id);
  if (status) query = query.eq("status", status);
  // Most-recent first so callers can take runs[0] as "the latest run" (the
  // LiveLogConsole relies on this to keep showing the last completed run's log).
  query = query.order("started_at", { ascending: false }).limit(20);

  const { data, error } = await query;
  if (error) {
    console.error("[/api/profiles/:id/runs] db error:", error.message);
    return NextResponse.json({ error: "Request failed" }, { status: 500 });
  }

  return NextResponse.json({ runs: data });
});

// ── DELETE — cancel the active run for this profile ───────────────────────────
// Sets the run_log status to "failed" with a user-cancel message.
// The orchestrator's checkCancellation() sees this at the next stage boundary
// and throws, causing the pipeline to exit cleanly.
export const DELETE = withUser(async (
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
, { user, supabase }) => {
  const { id } = await params;

  // Auth: verify the profile belongs to this user (RLS on run_logs uses profile owner)

  // Confirm the profile belongs to this user before touching run_logs
  const { data: profile } = await supabase
    .from("search_profiles")
    .select("id")
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle();

  if (!profile) return NextResponse.json({ error: "Profile not found" }, { status: 404 });

  // Mark all running logs for this profile as failed (admin client to bypass RLS)
  const admin = createAdminClient();
  const { data: cancelled, error } = await admin
    .from("run_logs")
    .update({
      status:        "failed",
      finished_at:   new Date().toISOString(),
      error_message: "Cancelled by user",
    })
    .eq("profile_id", id)
    .eq("status", "running")
    .select("id");

  if (error) {
    console.error("[/api/profiles/:id/runs] db error:", error.message);
    return NextResponse.json({ error: "Request failed" }, { status: 500 });
  }

  return NextResponse.json({ cancelled: cancelled?.length ?? 0 });
});

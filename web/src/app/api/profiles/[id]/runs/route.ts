import { createClient }      from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { NextResponse }      from "next/server";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status");

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let query = supabase.from("run_logs").select("id, status").eq("profile_id", id);
  if (status) query = query.eq("status", status);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ runs: data });
}

// ── DELETE — cancel the active run for this profile ───────────────────────────
// Sets the run_log status to "failed" with a user-cancel message.
// The orchestrator's checkCancellation() sees this at the next stage boundary
// and throws, causing the pipeline to exit cleanly.
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Auth: verify the profile belongs to this user (RLS on run_logs uses profile owner)
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

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

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ cancelled: cancelled?.length ?? 0 });
}

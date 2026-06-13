// Returns the log_lines stream for a single run.
//
// Used by LiveLogConsole on the jobs / runs pages to render a scrolling
// monospace console. Polled every ~1.5s while the run is active.
//
// RLS on run_logs already restricts to profile owner, so a simple SELECT
// with the user-scoped client suffices.

import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

interface RunLogRow {
  log_lines: { t: string; msg: string }[] | null;
  status:    string;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; runId: string }> }
) {
  const { id: profileId, runId } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Ensure the profile belongs to this user (defence-in-depth on top of RLS).
  const { data: profile } = await supabase
    .from("search_profiles")
    .select("id")
    .eq("id", profileId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!profile) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { data, error } = await supabase
    .from("run_logs")
    .select("log_lines, status")
    .eq("id", runId)
    .eq("profile_id", profileId)
    .maybeSingle<RunLogRow>();

  if (error)   return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data)   return NextResponse.json({ error: "Not found" },   { status: 404 });

  return NextResponse.json({
    lines:  data.log_lines ?? [],
    status: data.status,
  });
}

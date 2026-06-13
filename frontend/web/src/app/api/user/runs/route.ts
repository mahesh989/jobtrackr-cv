// Cross-profile run feed for the dashboard-wide RunNotifier toast.
// Returns recent run_logs (last 30 min) across all the user's profiles so
// the client can detect running→completed/failed transitions and toast
// regardless of which page the user is sitting on.

import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

interface RunRow {
  id:             string;
  profile_id:     string;
  status:         string;
  current_stage:  string | null;
  jobs_saved:     number;
  started_at:     string;
  finished_at:    string | null;
  search_profiles: { name: string } | null;
}

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("run_logs")
    .select("id, profile_id, status, current_stage, jobs_saved, started_at, finished_at, search_profiles!inner(name, user_id)")
    .eq("search_profiles.user_id", user.id)
    .gte("started_at", since)
    .order("started_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const runs = ((data ?? []) as unknown as RunRow[]).map((r) => ({
    id:            r.id,
    profile_id:    r.profile_id,
    profile_name:  r.search_profiles?.name ?? "Profile",
    status:        r.status,
    current_stage: r.current_stage,
    jobs_saved:    r.jobs_saved,
    finished_at:   r.finished_at,
  }));

  return NextResponse.json({ runs });
}

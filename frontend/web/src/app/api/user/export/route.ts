// Data export — GET /api/user/export
// Returns all of the authenticated user's data as JSON (AU Privacy Act right of access).

import { NextResponse } from "next/server";
import { withUser } from "@/lib/api-utils";

export const GET = withUser(async (_req, _ctx, { user, supabase }) => {

  const [{ data: profiles }, { data: userData }] = await Promise.all([
    supabase.from("search_profiles").select("*").eq("user_id", user.id),
    supabase.from("users").select("email, role, created_at, invite_code_used").eq("id", user.id).single(),
  ]);

  const profileIds = (profiles ?? []).map((p: { id: string }) => p.id);

  const [{ data: jobs }, { data: runLogs }] = await Promise.all([
    profileIds.length > 0
      ? supabase.from("jobs").select("title, company, location, source, posted_at, visa_likelihood, url, applied_at, dismissed_at, created_at").in("profile_id", profileIds)
      : Promise.resolve({ data: [] }),
    profileIds.length > 0
      ? supabase.from("run_logs").select("profile_id, started_at, finished_at, status, jobs_fetched, jobs_saved").in("profile_id", profileIds).order("started_at", { ascending: false }).limit(200)
      : Promise.resolve({ data: [] }),
  ]);

  const payload = {
    exported_at: new Date().toISOString(),
    user: { email: user.email, ...userData },
    profiles: profiles ?? [],
    jobs: jobs ?? [],
    run_logs: runLogs ?? [],
  };

  const filename = `jobtrackr-export-${new Date().toISOString().slice(0, 10)}.json`;
  return new NextResponse(JSON.stringify(payload, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
});

// Data export — GET /api/user/export
// Returns all of the authenticated user's data as JSON (AU Privacy Act right of access).

import { NextResponse } from "next/server";
import { jsonError, withUser } from "@/lib/api-utils";

export const GET = withUser(async (_req, _ctx, { user, supabase }) => {

  const [
    { data: profiles, error: profilesErr },
    { data: userData, error: userErr },
  ] = await Promise.all([
    supabase.from("search_profiles").select("*").eq("user_id", user.id),
    supabase.from("users").select("email, role, created_at, invite_code_used").eq("id", user.id).single(),
  ]);

  // This route exists to satisfy the AU Privacy Act right of access — a
  // discarded error here previously shipped a JSON file with silently
  // empty/partial sections at HTTP 200 with an attachment header, giving
  // the user no way to know the export they'd rely on in a formal access
  // request was incomplete. Fail the download instead.
  if (profilesErr) return jsonError(profilesErr.message, 500);
  if (userErr) return jsonError(userErr.message, 500);

  const profileIds = (profiles ?? []).map((p: { id: string }) => p.id);

  const [
    { data: jobs, error: jobsErr },
    { data: runLogs, error: runLogsErr },
  ] = await Promise.all([
    profileIds.length > 0
      ? supabase.from("jobs").select("title, company, location, source, posted_at, visa_likelihood, url, applied_at, dismissed_at, created_at").in("profile_id", profileIds)
      : Promise.resolve({ data: [], error: null }),
    profileIds.length > 0
      ? supabase.from("run_logs").select("profile_id, started_at, finished_at, status, jobs_fetched, jobs_saved").in("profile_id", profileIds).order("started_at", { ascending: false }).limit(200)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (jobsErr) return jsonError(jobsErr.message, 500);
  if (runLogsErr) return jsonError(runLogsErr.message, 500);

  const payload = {
    exported_at: new Date().toISOString(),
    user: { ...userData, email: user.email },
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

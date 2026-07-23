import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { triggerScheduleSync } from "@/lib/actions/_helpers";
import { jsonError, withUser } from "@/lib/api-utils";

/**
 * POST /api/profiles/resume-paused
 *
 * Resumes every profile_pause_state row owned by the caller: flips
 * search_profiles.is_active back on, deletes the pause row, and re-syncs
 * BullMQ schedules. Also clears any stale inactivity_warned_at so the user
 * gets a fresh 14-day warning window rather than an immediate re-warn.
 *
 * Never auto-resumes on its own — this route only fires when the user
 * explicitly clicks "Resume" on the paused-profiles banner.
 */
export const POST = withUser(async (_req, _ctx, { user }) => {

  const admin = createAdminClient();

  // RLS would also scope this to the caller via the own-read policy, but we
  // use the admin client for the writes (delete + update) since
  // profile_pause_state has no user write policy.
  const { data: pauseRows, error: loadErr } = await admin
    .from("profile_pause_state")
    .select("profile_id")
    .eq("user_id", user.id);

  if (loadErr) {
    return jsonError(loadErr.message, 500);
  }

  const profileIds = (pauseRows ?? []).map((r) => r.profile_id as string);

  if (profileIds.length === 0) {
    return NextResponse.json({ resumed: 0 });
  }

  let resumed = 0;
  for (const profileId of profileIds) {
    const { error: updateErr } = await admin
      .from("search_profiles")
      .update({ is_active: true })
      .eq("id", profileId)
      .eq("user_id", user.id);
    if (updateErr) {
      console.error(`[resume-paused] failed to reactivate profile ${profileId}:`, updateErr.message);
      continue;
    }
    await admin.from("profile_pause_state").delete().eq("profile_id", profileId);
    resumed++;
  }

  // Fresh start — clear stale warn state so the user isn't immediately
  // re-warned on their first day back.
  await admin
    .from("user_engagement")
    .update({ inactivity_warned_at: null })
    .eq("user_id", user.id);

  if (resumed > 0) triggerScheduleSync();

  return NextResponse.json({ resumed, total: profileIds.length });
});

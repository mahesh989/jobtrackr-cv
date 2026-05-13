// Account deletion — DELETE /api/user/delete
// Deletes all user data then removes the auth user. Irreversible.
// AU Privacy Act s.13G — individuals may request deletion of personal information.

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { NextResponse } from "next/server";

export async function DELETE() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Get profile IDs so we can clean up ai_cache entries
  const { data: profiles } = await supabase
    .from("search_profiles")
    .select("id")
    .eq("user_id", user.id);

  const profileIds = (profiles ?? []).map((p: { id: string }) => p.id);

  // Delete in dependency order. Jobs and run_logs cascade from search_profiles.
  // ai_cache has profile_id FK (nullable) — delete explicitly.
  if (profileIds.length > 0) {
    await supabase.from("ai_cache").delete().in("profile_id", profileIds);
    await supabase.from("search_profiles").delete().eq("user_id", user.id);
  }

  // Delete user row
  await supabase.from("users").delete().eq("id", user.id);

  // Delete auth user via admin client (bypasses RLS)
  const adminClient = createAdminClient();
  await adminClient.auth.admin.deleteUser(user.id);

  return NextResponse.json({ deleted: true });
}

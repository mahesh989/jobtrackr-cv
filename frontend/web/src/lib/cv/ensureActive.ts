/**
 * ensureSomeoneActive — invariant: when a user has any CV in their library,
 * exactly one of those CVs is `is_active = true`.
 *
 * Idempotent: returns immediately when an active CV already exists. When the
 * user has CVs but none flagged active (e.g. legacy uploads before the
 * auto-activate path, or after deleting the only active CV), the most
 * recently uploaded CV is promoted.
 *
 * Used by:
 *   - DELETE /api/cv/[id]              — after removing a row.
 *   - PATCH  /api/cv/[id]              — after a deactivate.
 *   - /dashboard/cv server page        — on every page load, so users land
 *                                         on a clean state even if no mutate
 *                                         happened to trigger the promote.
 */
import type { createAdminClient } from "@/lib/supabase/admin";

export async function ensureSomeoneActive(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
): Promise<void> {
  const { count } = await admin
    .from("cv_versions")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("is_active", true);
  if ((count ?? 0) > 0) return;

  const { data: candidate } = await admin
    .from("cv_versions")
    .select("id")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!candidate) return;

  await admin
    .from("cv_versions")
    .update({ is_active: true })
    .eq("id", candidate.id);
}

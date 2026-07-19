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
 *   - /cv server page        — on every page load, so users land
 *                                         on a clean state even if no mutate
 *                                         happened to trigger the promote.
 *
 * An unfinished "built in app" CV (pdf_storage_path = built://… and not yet
 * verified) is NEVER auto-promoted — an empty hand-built draft must not silently
 * become the CV the analysis pipeline uses.
 */
import type { createAdminClient } from "@/lib/supabase/admin";

function isUnfinishedDraft(row: { structured_cv_status?: string | null; pdf_storage_path?: string | null }): boolean {
  const built = String(row.pdf_storage_path ?? "").startsWith("built://");
  return built && row.structured_cv_status !== "verified";
}

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

  // Pick the newest CV that isn't an unfinished built draft. Filtering in JS
  // keeps this NULL-safe (a bare `.neq` would also drop legacy NULL-status rows).
  const { data: candidates } = await admin
    .from("cv_versions")
    .select("id, structured_cv_status, pdf_storage_path")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(50);

  const candidate = (candidates ?? []).find(c => !isUnfinishedDraft(c));
  if (!candidate) return;

  await admin
    .from("cv_versions")
    .update({ is_active: true })
    .eq("id", candidate.id);
}

// Account deletion — DELETE /api/user/delete
// Deletes all user data then removes the auth user. Irreversible.
// AU Privacy Act s.13G — individuals may request deletion of personal information.
//
// DB rows are removed by the auth-user delete below: public.users.id references
// auth.users ON DELETE CASCADE, and every user-owned table
// (search_profiles → jobs/run_logs/ai_cache, cv_versions, analysis_runs,
// cover_letters, voice_profiles, stories, user_integrations, user_preferences,
// applications, email_integrations) references one of those ON DELETE CASCADE.
// Storage objects are NOT covered by any cascade, so we remove them explicitly
// first, while the rows that hold their paths still exist.

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { NextResponse } from "next/server";

const isPath = (p: unknown): p is string =>
  typeof p === "string" && p.length > 0 && p !== "pending";

export async function DELETE() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  // ── 1. Gather Storage object paths before the rows cascade away ───────────
  const [{ data: cvs }, { data: runs }, { data: letters }] = await Promise.all([
    admin.from("cv_versions").select("pdf_storage_path").eq("user_id", user.id),
    admin.from("analysis_runs")
      .select("tailored_pdf_storage_path, tailored_cv_storage_path")
      .eq("user_id", user.id),
    admin.from("cover_letters").select("pdf_storage_path").eq("user_id", user.id),
  ]);

  const cvPaths = (cvs ?? [])
    .map((r: { pdf_storage_path: string | null }) => r.pdf_storage_path)
    .filter(isPath);
  const tailoredPaths = (runs ?? [])
    .flatMap((r: { tailored_pdf_storage_path: string | null; tailored_cv_storage_path: string | null }) =>
      [r.tailored_pdf_storage_path, r.tailored_cv_storage_path])
    .filter(isPath);
  const letterPaths = (letters ?? [])
    .map((r: { pdf_storage_path: string | null }) => r.pdf_storage_path)
    .filter(isPath);

  // ── 2. Remove Storage objects (best-effort — never block deletion) ────────
  const removals: Promise<unknown>[] = [];
  if (cvPaths.length)       removals.push(admin.storage.from("cvs").remove(cvPaths));
  if (tailoredPaths.length) removals.push(admin.storage.from("tailored-cvs").remove(tailoredPaths));
  if (letterPaths.length)   removals.push(admin.storage.from("cover-letters").remove(letterPaths));
  // Sweep any stragglers left in the user's cvs/ folder (path = `${user.id}/...`).
  removals.push(
    admin.storage.from("cvs").list(user.id).then(({ data }) => {
      const names = (data ?? []).map((o: { name: string }) => `${user.id}/${o.name}`);
      return names.length ? admin.storage.from("cvs").remove(names) : null;
    }),
  );
  for (const r of await Promise.allSettled(removals)) {
    if (r.status === "rejected") console.error("[user/delete] storage cleanup error:", r.reason);
  }

  // ── 3. Delete the auth user — cascades every user-owned DB row ────────────
  const { error: delErr } = await admin.auth.admin.deleteUser(user.id);
  if (delErr) {
    console.error("[user/delete] auth deleteUser failed:", delErr.message);
    return NextResponse.json({ error: "Account deletion failed. Please try again." }, { status: 500 });
  }

  return NextResponse.json({ deleted: true });
}

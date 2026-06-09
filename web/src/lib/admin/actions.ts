"use server";

import { requireAdmin } from "@/lib/admin/guard";
import { revalidatePath } from "next/cache";

/**
 * Force a stuck analysis run (status='running') to failed.
 * Only admins/founders can call this — requireAdmin() redirects others.
 */
export async function adminForceCancelRun(runId: string) {
  const { admin } = await requireAdmin();

  const { error } = await admin
    .from("analysis_runs")
    .update({
      status: "failed",
      error_message: "Force cancelled by admin",
      updated_at: new Date().toISOString(),
    })
    .eq("id", runId)
    .eq("status", "running");

  if (error) throw new Error(error.message);
  revalidatePath("/dashboard/admin/pipeline");
}

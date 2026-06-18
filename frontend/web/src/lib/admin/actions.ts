"use server";

import { requireAdmin } from "@/lib/admin/guard";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";

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

/**
 * Grant a user permanent unlimited access by setting their subscription to
 * status='active' + plan_id='unlimited' with a 10-year period.
 * Works whether the user has no sub, an expired comp, or a trialing row.
 */
export async function adminGrantUnlimitedAccess(userId: string) {
  await requireAdmin();
  const admin = createAdminClient();

  const periodStart = new Date().toISOString();
  const periodEnd   = new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000).toISOString();

  const { error } = await admin
    .from("subscriptions")
    .upsert(
      {
        user_id:               userId,
        plan_id:               "unlimited",
        status:                "active",
        current_period_start:  periodStart,
        current_period_end:    periodEnd,
        trial_end:             null,
        stripe_subscription_id: null,
        stripe_customer_id:    null,
      },
      { onConflict: "user_id" },
    );

  if (error) throw new Error(error.message);
  revalidatePath(`/dashboard/admin/users/${userId}`);
}

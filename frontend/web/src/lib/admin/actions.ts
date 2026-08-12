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
  revalidatePath("/admin/pipeline");
}

/**
 * Grant a user permanent unlimited access by setting their subscription to
 * status='comp' + plan_id='comp' (the schema's own "grandfathered, no Stripe
 * sub" status — see entitlements.ts) with a 10-year period. Works whether
 * the user has no sub, an expired comp, or a trialing row.
 *
 * MUST NOT null stripe_customer_id/stripe_subscription_id (#50): a user who
 * already has a live Stripe linkage keeps it — those two columns are
 * intentionally left OUT of the upsert payload, so Postgres leaves them
 * untouched on the UPDATE branch (Postgres only default them to NULL on a
 * genuinely new INSERT, which is correct for a user with no prior sub).
 * The old code explicitly set them to null, which severed a paying user's
 * billing linkage while Stripe kept charging their card in the background —
 * /billing showed no card/invoices/cancel control (details.ts's
 * `if (!row?.stripe_customer_id) return EMPTY`) and the portal route 422'd.
 *
 * plan_id='unlimited' was also wrong on its own: it's a REAL paid catalog
 * plan ($29.99/mo, 003_seed.sql), so a comp'd user's own admin page showed a
 * live price for a subscription nobody is paying for. 'comp' is the status
 * this schema was built for.
 *
 * Known residual, not fixed here: if the target user has (or later starts)
 * a genuinely live Stripe subscription, a subsequent real webhook event for
 * THAT subscription still overwrites plan_id/status back from Stripe
 * (syncSubscription.ts resolves the same user_id and upserts onConflict:
 * "user_id" — see #36/#37). Preserving the linkage means that no longer
 * locks the user out of billing (the P1 this fix closes) — it just means a
 * comp grant layered on top of a still-active real subscription isn't
 * durable against that subscription's own webhook traffic, which matches
 * this file's own documented convention that "the webhook is the ONLY
 * writer of paid status" for a genuinely live Stripe subscription.
 */
export async function adminGrantUnlimitedAccess(userId: string) {
  const { admin } = await requireAdmin();

  const periodStart = new Date().toISOString();
  const periodEnd   = new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000).toISOString();

  const { error } = await admin
    .from("subscriptions")
    .upsert(
      {
        user_id:               userId,
        plan_id:               "comp",
        status:                "comp",
        current_period_start:  periodStart,
        current_period_end:    periodEnd,
        trial_end:             null,
      },
      { onConflict: "user_id" },
    );

  if (error) throw new Error(error.message);
  revalidatePath(`/admin/users/${userId}`);
}

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
 * sub" status — see entitlements.ts) with a 10-year period. Works for a user
 * with no sub, an expired comp, or a wrong/stale non-live plan.
 *
 * REFUSES when the user already has a LIVE Stripe-driven subscription
 * (status active/trialing/past_due with a real stripe_subscription_id) —
 * see #50 and independent review of this chunk. Two compounding reasons,
 * not one:
 *   1. Overwriting status to 'comp' while PRESERVING a live customer id (see
 *      below) removes the only signal checkoutDecision.ts's double-billing
 *      guard has ('comp' is not in LIVE_STATES) — the user could reach
 *      /pricing and start a SECOND concurrently-charging subscription.
 *   2. A 'trialing' row can only ever be written by
 *      upsertFromSubscription/syncSubscription.ts (grepped: no other writer
 *      of that status in the codebase) — it always means a real Stripe
 *      trial that will auto-convert and charge. Comping it without
 *      cancelling the real one in Stripe first is the exact dangerous state
 *      this function must not create silently.
 * The thrown error tells the admin to cancel the real subscription in
 * Stripe first. A non-live row (canceled/unpaid/incomplete/incomplete_expired,
 * or none at all) is unaffected and proceeds as before.
 *
 * MUST NOT null stripe_customer_id/stripe_subscription_id (#50) on a
 * non-live row: those two columns are intentionally left OUT of the upsert
 * payload, so Postgres leaves them untouched on the UPDATE branch (Postgres
 * only defaults them to NULL on a genuinely new INSERT, which is correct
 * for a user with no prior sub). The old code explicitly nulled them, which
 * severed a paying user's billing linkage while Stripe kept charging their
 * card in the background — /billing showed no card/invoices/cancel control
 * (details.ts's `if (!row?.stripe_customer_id) return EMPTY`) and the
 * portal route 422'd. The billing page's ManageButton visibility was
 * updated (details.ts/billing/page.tsx) to key off whether a Stripe
 * customer id exists rather than off status==='comp', so a comp'd row that
 * still carries an old (non-live) customer id keeps a working portal link.
 *
 * plan_id='unlimited' was also wrong on its own: it's a REAL paid catalog
 * plan ($29.99/mo, 003_seed.sql), so a comp'd user's own admin page showed a
 * live price for a subscription nobody is paying for. 'comp' is the status
 * this schema was built for.
 *
 * Known residual, not fixed here: the guard above only blocks LIVE statuses.
 * A row with a NON-live status (e.g. 'unpaid') that still has a real
 * `stripe_subscription_id` can be comped, and a LATER real webhook event for
 * that same subscription
 * (syncSubscription.ts resolves the same user_id, onConflict:"user_id" — see
 * #36/#37) can still overwrite plan_id/status back from Stripe, silently
 * undoing the grant. Matches this file's own documented convention that "the
 * webhook is the ONLY writer of paid status" for a subscription that still
 * exists at Stripe — the admin should confirm the real subscription is
 * actually being cancelled in Stripe, not just assume the grant is durable.
 */
export async function adminGrantUnlimitedAccess(userId: string) {
  const { admin } = await requireAdmin();

  const { data: existing, error: fetchError } = await admin
    .from("subscriptions")
    .select("status, stripe_subscription_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (fetchError) throw new Error(fetchError.message);

  const row = existing as { status?: string | null; stripe_subscription_id?: string | null } | null;
  const LIVE_STATES = new Set(["active", "trialing", "past_due"]);
  if (row?.stripe_subscription_id && row.status && LIVE_STATES.has(row.status)) {
    throw new Error(
      `This user has a live Stripe subscription (${row.stripe_subscription_id}, status=${row.status}). ` +
      "Cancel it in Stripe first, then grant comp access — granting it on top of a live subscription " +
      "would let the user start a second, concurrently-charging one via /pricing.",
    );
  }

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
        cancel_at_period_end:  false,
        updated_at:            new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );

  if (error) throw new Error(error.message);
  revalidatePath(`/admin/users/${userId}`);
}

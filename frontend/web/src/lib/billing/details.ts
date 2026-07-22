/**
 * Billing snapshot — read-only Stripe facts for the billing page.
 * Server-only (imports the Stripe client) — never import from "use client".
 *
 * Everything here is presentational garnish on top of the entitlement layer:
 * the card on file, recent invoices, cancel-at-period-end, and the plan the
 * trial converts into. All calls are individually guarded — a Stripe hiccup
 * degrades to nulls/empty rather than breaking the page.
 */

import Stripe from "stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStripe } from "./stripe";
import type { PlanId } from "./plans";

export interface CardOnFile {
  brand: string;   // "visa" | "mastercard" | …
  last4: string;
  expMonth: number;
  expYear: number;
}

export interface InvoiceRow {
  id: string;
  date: string;          // ISO
  amountCents: number;   // invoice total
  currency: string;      // "aud"
  status: string;        // paid | open | void | uncollectible | draft
  url: string | null;    // hosted invoice page
}

export interface BillingSnapshot {
  cancelAtPeriodEnd: boolean;
  /** The plan the subscription is actually on (unmasked by trial caps). */
  subscribedPlan: PlanId | null;
  card: CardOnFile | null;
  invoices: InvoiceRow[];
}

const EMPTY: BillingSnapshot = {
  cancelAtPeriodEnd: false,
  subscribedPlan: null,
  card: null,
  invoices: [],
};

function cardFromPm(pm: Stripe.PaymentMethod | null | undefined): CardOnFile | null {
  if (!pm?.card) return null;
  return {
    brand: pm.card.brand,
    last4: pm.card.last4,
    expMonth: pm.card.exp_month,
    expYear: pm.card.exp_year,
  };
}

export async function getBillingSnapshot(userId: string): Promise<BillingSnapshot> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("subscriptions")
    .select("stripe_customer_id, stripe_subscription_id, cancel_at_period_end, plan_id")
    .eq("user_id", userId)
    .maybeSingle();

  const row = data as {
    stripe_customer_id?: string | null;
    stripe_subscription_id?: string | null;
    cancel_at_period_end?: boolean | null;
    plan_id?: PlanId | null;
  } | null;

  if (!row?.stripe_customer_id) return EMPTY;

  const base: BillingSnapshot = {
    ...EMPTY,
    cancelAtPeriodEnd: !!row.cancel_at_period_end,
    subscribedPlan: row.plan_id ?? null,
  };

  let stripe: Stripe;
  try {
    stripe = getStripe();
  } catch {
    return base; // no key configured (e.g. local dev) — degrade gracefully
  }

  const [card, invoices] = await Promise.all([
    loadCard(stripe, row.stripe_customer_id, row.stripe_subscription_id ?? null),
    loadInvoices(stripe, row.stripe_customer_id),
  ]);

  return { ...base, card, invoices };
}

/** Default card: subscription PM first (Checkout sets it there), else customer default. */
async function loadCard(
  stripe: Stripe,
  customerId: string,
  subscriptionId: string | null,
): Promise<CardOnFile | null> {
  try {
    if (subscriptionId) {
      const sub = await stripe.subscriptions.retrieve(subscriptionId, {
        expand: ["default_payment_method"],
      });
      const fromSub = cardFromPm(sub.default_payment_method as Stripe.PaymentMethod | null);
      if (fromSub) return fromSub;
    }
    const customer = await stripe.customers.retrieve(customerId, {
      expand: ["invoice_settings.default_payment_method"],
    });
    if (customer.deleted) return null;
    return cardFromPm(
      customer.invoice_settings?.default_payment_method as Stripe.PaymentMethod | null,
    );
  } catch {
    return null;
  }
}

async function loadInvoices(stripe: Stripe, customerId: string): Promise<InvoiceRow[]> {
  try {
    const list = await stripe.invoices.list({ customer: customerId, limit: 6 });
    return list.data
      .filter((inv) => inv.status !== "draft")
      .map((inv) => ({
        id: inv.id ?? "",
        date: new Date(inv.created * 1000).toISOString(),
        amountCents: inv.total,
        currency: inv.currency,
        status: inv.status ?? "open",
        url: inv.hosted_invoice_url ?? null,
      }));
  } catch {
    return [];
  }
}

/** "A$9.99" for aud, "$9.99 USD"-style fallback otherwise. */
export function formatAmount(cents: number, currency: string): string {
  const n = (cents / 100).toFixed(2);
  return currency.toLowerCase() === "aud" ? `A$${n}` : `${n} ${currency.toUpperCase()}`;
}

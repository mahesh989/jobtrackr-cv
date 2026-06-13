/**
 * Stripe server client + price-id map. Server-only — never import in a
 * "use client" module. The secret key and webhook secret are Vercel env vars.
 */

import Stripe from "stripe";
import type { PlanId } from "./plans";

let _stripe: Stripe | null = null;

/** Lazily construct the Stripe client so a missing key only throws on use. */
export function getStripe(): Stripe {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
  _stripe = new Stripe(key, {
    // Pin the API version Stripe ships with this SDK major.
    apiVersion: "2026-05-27.dahlia",
    appInfo: { name: "JobTrackr", url: "https://jobtrackr-cv.vercel.app" },
  });
  return _stripe;
}

/** Map a purchasable plan → its Stripe Price ID (env-configured). */
export function priceIdForPlan(plan: PlanId): string | null {
  switch (plan) {
    case "weekly":    return process.env.STRIPE_PRICE_WEEKLY    ?? null;
    case "monthly":   return process.env.STRIPE_PRICE_MONTHLY   ?? null;
    case "unlimited": return process.env.STRIPE_PRICE_UNLIMITED ?? null;
    default:          return null; // trial / comp have no Stripe price
  }
}

/** Reverse map: Stripe Price ID → our plan id (used by the webhook). */
export function planForPriceId(priceId: string | null | undefined): PlanId | null {
  if (!priceId) return null;
  if (priceId === process.env.STRIPE_PRICE_WEEKLY)    return "weekly";
  if (priceId === process.env.STRIPE_PRICE_MONTHLY)   return "monthly";
  if (priceId === process.env.STRIPE_PRICE_UNLIMITED) return "unlimited";
  return null;
}

export const STRIPE_WEBHOOK_SECRET = () => {
  const s = process.env.STRIPE_WEBHOOK_SECRET;
  if (!s) throw new Error("STRIPE_WEBHOOK_SECRET is not set");
  return s;
};

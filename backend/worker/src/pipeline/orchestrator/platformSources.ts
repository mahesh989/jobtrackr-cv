import { db } from "../../db/client.js";
import { ADMIN_ROLES } from "../../lib/adminRoles.js";
import type { SubscriptionTier, PlatformSources } from "./types.js";

export function planToTier(planId: string | null | undefined, status: string | null | undefined): SubscriptionTier {
  if (status === "comp") return "unlimited";
  if (planId === "monthly")   return "monthly";
  if (planId === "unlimited") return "unlimited";
  return "weekly";  // trial, null, unknown → free tier
}

/**
 * Load the per-subscription-tier source config (migration 064). Resolves the
 * user's current plan → tier row in platform_source_tiers → source settings.
 * Founders/admins always receive the unlimited tier. Falls back to weekly (free)
 * defaults if the DB is unavailable or the row is missing.
 */
export async function loadPlatformSources(userId: string): Promise<PlatformSources> {
  const freeFallback: PlatformSources = {
    tier:            "weekly",
    enabled_sources: ["adzuna", "seek", "careerjet"],
    adzuna_method:   "api",
    seek_method:     "direct",
  };
  try {
    let tier: SubscriptionTier = "weekly";

    // Founders/admins always get the unlimited tier (no Stripe sub needed).
    const { data: userRow } = await db
      .from("users")
      .select("role")
      .eq("id", userId)
      .maybeSingle();
    if (userRow?.role && (ADMIN_ROLES as readonly string[]).includes(userRow.role)) {
      tier = "unlimited";
    } else {
      const { data: sub } = await db
        .from("subscriptions")
        .select("plan_id, status")
        .eq("user_id", userId)
        .maybeSingle();
      tier = planToTier(sub?.plan_id as string | null, sub?.status as string | null);
    }

    const { data } = await db
      .from("platform_source_tiers")
      .select("enabled_sources, adzuna_method, seek_method")
      .eq("tier", tier)
      .maybeSingle();

    if (!data) {
      console.warn(`[pipeline] platform_source_tiers row missing for tier=${tier}, using free defaults`);
      return freeFallback;
    }
    console.log(`[pipeline] sources tier=${tier} (plan lookup for user ${userId})`);
    return {
      tier,
      enabled_sources: (data.enabled_sources as string[] | null) ?? freeFallback.enabled_sources,
      adzuna_method:   (data.adzuna_method as "api" | "direct" | null) ?? freeFallback.adzuna_method,
      seek_method:     (data.seek_method as "direct" | "actor" | null) ?? freeFallback.seek_method,
    };
  } catch (err) {
    console.warn(`[pipeline] platform_source_tiers load failed, using free defaults: ${err instanceof Error ? err.message : err}`);
    return freeFallback;
  }
}

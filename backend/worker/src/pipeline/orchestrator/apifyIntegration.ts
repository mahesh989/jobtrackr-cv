import { db } from "../../db/client.js";
import { decryptApiKey } from "../../lib/crypto.js";
import { createSeekAdapter } from "../../sources/seek.js";
import type { UserIntegration } from "./types.js";

export const SEEK_MONTHLY_BUDGET_USD = 5.0;   // Apify free tier

/** Persist an incremental Apify spend on the shared integration row. */
export async function addApifySpend(
  integrationId: string,
  costUsd: number,
  budgetUsd: number,
  currentSpend: number,
): Promise<void> {
  // Re-read to avoid clobbering a concurrent increment in the same run.
  const { data: fresh } = await db.from("user_integrations")
    .select("quota_used_usd").eq("id", integrationId).single();
  const baseSpend = fresh?.quota_used_usd ?? currentSpend;
  const newSpend  = baseSpend + costUsd;
  await db.from("user_integrations").update({
    quota_used_usd: newSpend,
    last_used_at:   new Date().toISOString(),
    status:         newSpend >= budgetUsd ? "quota_exceeded" : "valid",
    status_reason:  newSpend >= budgetUsd ? `Monthly budget of $${budgetUsd} reached` : null,
    updated_at:     new Date().toISOString(),
  }).eq("id", integrationId);
}

/**
 * Load an Apify integration row for the running profile.
 *
 * Resolution order:
 *   1. The profile owner's own integration (legacy BYO-Apify support).
 *   2. Fallback: an admin/founder's integration (the platform/admin model —
 *      one paid Apify token serves every user). Picked deterministically
 *      (first valid, enabled, lowest created_at).
 *
 * Returns null only if BOTH lookups fail. The shared spend is accumulated
 * on whichever row we used (admin row when on the fallback), so the admin's
 * existing budget UI shows total platform Apify usage.
 */
export async function loadApifyIntegration(userId: string): Promise<UserIntegration | null> {
  const COLS = "id, encrypted_api_key, status, quota_used_usd, quota_used_requests, quota_period_start, is_enabled, config";
  const own = await db
    .from("user_integrations")
    .select(COLS)
    .eq("user_id", userId)
    .eq("provider", "apify")
    .maybeSingle();
  if (own.data) return own.data as UserIntegration;

  // Fallback: any founder/admin's Apify integration (platform model).
  const { data: admins } = await db
    .from("users")
    .select("id")
    .in("role", ["founder", "admin"]);
  const adminIds = (admins ?? []).map((u: { id: string }) => u.id);
  if (adminIds.length === 0) return null;

  const { data: row } = await db
    .from("user_integrations")
    .select(COLS)
    .in("user_id", adminIds)
    .eq("provider", "apify")
    .eq("is_enabled", true)
    .eq("status", "valid")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  return row as UserIntegration | null;
}

/** Reset quota counters when we've rolled into a new calendar month. */
export async function maybeResetQuota(integration: UserIntegration): Promise<UserIntegration> {
  const currentPeriod = new Date().toISOString().slice(0, 7);      // "YYYY-MM"
  const storedPeriod  = integration.quota_period_start.slice(0, 7);

  if (storedPeriod >= currentPeriod) return integration;  // still in same month

  // New month — reset spend
  const newPeriodStart = `${currentPeriod}-01`;
  await db
    .from("user_integrations")
    .update({
      quota_used_usd:      0,
      quota_used_requests: 0,
      quota_period_start:  newPeriodStart,
      updated_at:          new Date().toISOString(),
    })
    .eq("id", integration.id);

  return { ...integration, quota_used_usd: 0, quota_used_requests: 0, quota_period_start: newPeriodStart };
}

/**
 * Load the shared Apify credential.
 *
 * NAMING: the locals are called seek* for historical reasons, but this ONE
 * credential funds three different actors - SEEK listings, the Careerjet JD
 * fetcher (stage 7c) and the Adzuna JD fetcher (stage 7d) - all metering spend
 * onto the same integration row via addApifySpend. Renaming is deferred so this
 * refactor stays pure code motion.
 *
 * Never throws: integration loading must not be able to kill a run.
 */
export async function loadApifyCredential(userId: string): Promise<{
  integration: UserIntegration | null;
  adapter: ReturnType<typeof createSeekAdapter> | null;
  token: string | null;
}> {
  let seekIntegration: UserIntegration | null = null;
  let seekAdapter: ReturnType<typeof createSeekAdapter> | null = null;
  let seekToken: string | null = null;  // kept for post-dedup JD enrichment


  try {
    const raw = await loadApifyIntegration(userId);
    if (raw && raw.is_enabled && raw.status === "valid") {
      seekIntegration = await maybeResetQuota(raw);
      const remaining = SEEK_MONTHLY_BUDGET_USD - seekIntegration.quota_used_usd;
      if (remaining > 0.01) {
        seekToken    = decryptApiKey(seekIntegration.encrypted_api_key);
        seekAdapter  = createSeekAdapter(seekToken);
        console.log(`[pipeline] SEEK adapter ready — $${remaining.toFixed(2)} remaining this month`);
      } else {
        console.log(`[pipeline] SEEK skipped — Apify monthly budget exhausted ($${SEEK_MONTHLY_BUDGET_USD})`);
        // Mark quota_exceeded so the UI can show the right state
        await db.from("user_integrations")
          .update({ status: "quota_exceeded", status_reason: `Monthly budget of $${SEEK_MONTHLY_BUDGET_USD} reached`, updated_at: new Date().toISOString() })
          .eq("id", seekIntegration.id);
      }
    } else if (raw) {
      console.log(`[pipeline] SEEK skipped — integration status: ${raw.status}`);
    } else {
      console.log(`[pipeline] SEEK skipped — no Apify integration configured`);
    }
  } catch (err) {
    // Never let integration loading crash the whole pipeline
    console.warn(`[pipeline] SEEK integration load failed: ${err instanceof Error ? err.message : err}`);
  }

  return { integration: seekIntegration, adapter: seekAdapter, token: seekToken };
}

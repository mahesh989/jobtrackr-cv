/**
 * /api/integrations/apify
 *
 * POST  — validate token with Apify, encrypt, upsert to user_integrations
 * GET   — return status + quota usage (never the token)
 * DELETE — disconnect (soft-delete: sets status=disabled, clears encrypted key)
 *
 * All operations are server-side only. The raw token never leaves this file.
 * The browser only ever sees: { status, quota_used_usd, quota_period_start, … }
 */

import { NextResponse }              from "next/server";
import { createAdminClient }         from "@/lib/supabase/admin";
import { encryptApiKey, decryptApiKey } from "@/lib/integrations/crypto";
import { rateLimit, RATE_LIMIT_MESSAGE } from "@/lib/rateLimit";
import { jsonError, withUser }                  from "@/lib/api-utils";

const MONTHLY_BUDGET = 5.0;

// ── Apify API helpers ──────────────────────────────────────────────────────────

async function validateApifyToken(token: string): Promise<{ valid: boolean; error?: string }> {
  try {
    const res = await fetch("https://api.apify.com/v2/users/me", {
      headers: { Authorization: `Bearer ${token}` },
      signal:  AbortSignal.timeout(8_000),
    });
    if (res.ok) return { valid: true };
    if (res.status === 401) return { valid: false, error: "Invalid API token — check and try again" };
    return { valid: false, error: `Apify returned ${res.status}` };
  } catch (err) {
    return { valid: false, error: `Could not reach Apify: ${err instanceof Error ? err.message : "network error"}` };
  }
}

/**
 * Fetch the user's real current-month spend and plan limit directly from Apify.
 * Apify exposes this via GET /v2/users/me/limits:
 *   { data: { current: { monthlyUsageUsd }, limits: { maxMonthlyUsageUsd } } }
 *
 * Falls back to null if the endpoint is unavailable or the response shape changes.
 */
async function fetchApifyUsage(token: string): Promise<{
  usedUsd: number;
  limitUsd: number;
} | null> {
  try {
    const res = await fetch("https://api.apify.com/v2/users/me/limits", {
      headers: { Authorization: `Bearer ${token}` },
      signal:  AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;

    // Apify GET /v2/users/me/limits response shape:
    // { data: { current: { monthlyUsageUsd }, limits: { maxMonthlyUsageUsd } } }
    const json = await res.json() as {
      data?: {
        current?: { monthlyUsageUsd?: number };
        limits?:  { maxMonthlyUsageUsd?: number };
      };
    };

    const usedUsd  = json.data?.current?.monthlyUsageUsd;
    const limitUsd = json.data?.limits?.maxMonthlyUsageUsd;

    if (typeof usedUsd !== "number") return null;

    return {
      usedUsd,
      limitUsd: typeof limitUsd === "number" ? limitUsd : MONTHLY_BUDGET,
    };
  } catch {
    return null;
  }
}

// ── POST — connect / replace token ────────────────────────────────────────────

export const POST = withUser(async (req, _ctx, { user }) => {

  let token: string;
  try {
    const body = await req.json();
    token = (body.token ?? "").trim();
  } catch {
    return jsonError("Invalid request body", 400);
  }

  if (!token) return jsonError("Token is required", 400);

  // Rate limit: POST validates the token against Apify's API — cap to prevent
  // using this endpoint as a token-validation oracle.
  const rl = await rateLimit(`apify-validate:${user.id}`, 10, 60);
  if (!rl.allowed) return jsonError(RATE_LIMIT_MESSAGE, 429);

  // Validate with Apify before storing anything
  const { valid, error: validationError } = await validateApifyToken(token);
  if (!valid) {
    return NextResponse.json({ valid: false, error: validationError }, { status: 422 });
  }

  // Encrypt — raw token is discarded after this point
  const encrypted = encryptApiKey(token);

  // Upsert — one row per user per provider
  const admin = createAdminClient();
  const currentPeriodStart = new Date().toISOString().slice(0, 7) + "-01";  // "YYYY-MM-01"

  const { error: dbError } = await admin
    .from("user_integrations")
    .upsert(
      {
        user_id:           user.id,
        provider:          "apify",
        encrypted_api_key: encrypted,
        status:            "valid",
        status_reason:     null,
        last_validated_at: new Date().toISOString(),
        // Reset quota on reconnect (new token = fresh budget)
        quota_used_usd:      0,
        quota_used_requests: 0,
        quota_period_start:  currentPeriodStart,
        is_enabled:          true,
        updated_at:          new Date().toISOString(),
      },
      { onConflict: "user_id,provider" }
    );

  if (dbError) {
    console.error("[integrations/apify] db error:", dbError.message);
    return jsonError("Failed to save integration", 500);
  }

  return NextResponse.json({ valid: true });
});

// ── GET — sync real usage from Apify, return status ───────────────────────────

export const GET = withUser(async (_req, _ctx, { user }) => {

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("user_integrations")
    .select("status, status_reason, last_validated_at, last_used_at, quota_used_usd, quota_used_requests, quota_period_start, is_enabled, config, encrypted_api_key")
    .eq("user_id", user.id)
    .eq("provider", "apify")
    .maybeSingle();

  if (error) {
    console.error("[/api/integrations/apify] db error:", error.message);
    return jsonError("Request failed", 500);
  }
  if (!data)  return NextResponse.json({ connected: false });

  // ── Sync real usage from Apify ────────────────────────────────────────────
  // Decrypt token server-side and call Apify's limits endpoint.
  // This keeps our DB in sync with what Apify actually shows the user.
  let usedUsd   = data.quota_used_usd   as number ?? 0;
  let limitUsd  = MONTHLY_BUDGET;

  if (data.status === "valid" && data.encrypted_api_key) {
    try {
      const token   = decryptApiKey(data.encrypted_api_key as string);
      const apify   = await fetchApifyUsage(token);

      if (apify) {
        usedUsd  = apify.usedUsd;
        limitUsd = apify.limitUsd;

        // Determine new status based on real quota
        const newStatus = usedUsd >= limitUsd ? "quota_exceeded" : "valid";

        // Persist real values — keeps worker's estimate in sync too
        await admin.from("user_integrations").update({
          quota_used_usd:   usedUsd,
          status:           newStatus,
          status_reason:    newStatus === "quota_exceeded"
            ? `Monthly budget of $${limitUsd.toFixed(0)} reached`
            : null,
          updated_at:       new Date().toISOString(),
        }).eq("user_id", user.id).eq("provider", "apify");
      }
    } catch {
      // Decryption or network failure — fall back to DB value, don't crash
    }
  }

  // ── Build response ────────────────────────────────────────────────────────
  const periodStart   = data.quota_period_start as string;
  const [year, month] = periodStart.split("-").map(Number);
  const nextResetDate = new Date(year, month, 1).toLocaleDateString("en-AU", {
    day: "numeric", month: "long", year: "numeric",
  });

  return NextResponse.json({
    connected:            true,
    status:               data.status,
    status_reason:        data.status_reason,
    last_validated_at:    data.last_validated_at,
    last_used_at:         data.last_used_at,
    quota_used_usd:       usedUsd,
    quota_used_requests:  data.quota_used_requests,
    quota_remaining_usd:  Math.max(0, limitUsd - usedUsd),
    monthly_budget_usd:   limitUsd,
    quota_resets_on:      nextResetDate,
    is_enabled:           data.is_enabled,
  });
});

// ── DELETE — disconnect ────────────────────────────────────────────────────────

export const DELETE = withUser(async (_req, _ctx, { user }) => {

  const admin = createAdminClient();

  // Hard delete — user can reconnect with a fresh token any time
  const { error } = await admin
    .from("user_integrations")
    .delete()
    .eq("user_id", user.id)
    .eq("provider", "apify");

  if (error) {
    console.error("[/api/integrations/apify] db error:", error.message);
    return jsonError("Request failed", 500);
  }

  return NextResponse.json({ disconnected: true });
});

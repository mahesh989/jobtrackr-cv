/**
 * OAuth token storage helpers for email_integrations.
 *
 * Tokens are serialised to JSON, then AES-256-GCM encrypted (same key as
 * other integrations), and stored as a base64 string in the `oauth_token`
 * text column. Only ever call these from server-side code.
 */

import { encryptApiKey, decryptApiKey } from "@/lib/integrations/crypto";
import { createAdminClient }            from "@/lib/supabase/admin";

export interface StoredTokens {
  access_token:  string;
  refresh_token: string;
  expiry_at:     string;   // ISO-8601
  email:         string;   // sender address (user's Gmail / Outlook email)
  provider:      "google" | "microsoft";
}

// ── Persist ──────────────────────────────────────────────────────────────────

export async function saveTokens(userId: string, tokens: StoredTokens): Promise<void> {
  const encrypted = encryptApiKey(JSON.stringify(tokens));   // throws if INTEGRATION_ENCRYPTION_KEY missing/wrong
  const admin     = createAdminClient();                     // throws if Supabase URL/service-role key missing

  const { error } = await admin
    .from("email_integrations")
    .upsert({
      user_id:      userId,
      provider:     tokens.provider,
      oauth_token:  encrypted,
      from_address: tokens.email,
      updated_at:   new Date().toISOString(),
    }, { onConflict: "user_id" });

  if (error) {
    console.error("[saveTokens] upsert failed:", error);
    throw new Error(`email_integrations upsert failed: ${error.message}`);
  }
}

// ── Load ─────────────────────────────────────────────────────────────────────

async function loadTokens(userId: string): Promise<StoredTokens | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("email_integrations")
    .select("oauth_token")
    .eq("user_id", userId)
    .maybeSingle();

  if (!data?.oauth_token) return null;
  try {
    return JSON.parse(decryptApiKey(data.oauth_token)) as StoredTokens;
  } catch {
    return null;
  }
}

// ── Delete ───────────────────────────────────────────────────────────────────

export async function deleteTokens(userId: string): Promise<void> {
  const admin = createAdminClient();
  await admin.from("email_integrations").delete().eq("user_id", userId);
}

// ── Refresh ───────────────────────────────────────────────────────────────────
// Returns a valid access_token, refreshing if within 5 min of expiry.
// Throws if no integration is connected or refresh fails.

const REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

export async function getValidAccessToken(
  userId: string,
): Promise<{ access_token: string; email: string; provider: "google" | "microsoft" }> {
  const tokens = await loadTokens(userId);
  if (!tokens) throw new Error("No email integration connected");

  const expiresAt = new Date(tokens.expiry_at).getTime();
  const needsRefresh = Date.now() + REFRESH_BUFFER_MS >= expiresAt;

  if (!needsRefresh) {
    return { access_token: tokens.access_token, email: tokens.email, provider: tokens.provider };
  }

  // Refresh
  let refreshed: { access_token: string; refresh_token?: string; expiry_at: string };
  try {
    refreshed = tokens.provider === "google"
      ? await refreshGoogleToken(tokens.refresh_token)
      : await refreshMicrosoftToken(tokens.refresh_token);
  } catch (err) {
    // If Google/Microsoft rejected the refresh token (400), the stored token is
    // permanently dead. Clear it so the UI shows "Connect Gmail" again instead
    // of a confusing "token refresh failed" error on every action.
    if ((err as { shouldDisconnect?: boolean }).shouldDisconnect) {
      await deleteTokens(userId).catch(() => {});
      throw new Error("Your Gmail connection has expired — please reconnect it in My CV → Email account.");
    }
    throw err;
  }

  const updated: StoredTokens = {
    ...tokens,
    access_token:  refreshed.access_token,
    refresh_token: refreshed.refresh_token ?? tokens.refresh_token,
    expiry_at:     refreshed.expiry_at,
  };
  await saveTokens(userId, updated);

  return { access_token: updated.access_token, email: updated.email, provider: updated.provider };
}

// ── Provider refresh implementations ─────────────────────────────────────────

async function refreshGoogleToken(
  refresh_token: string,
): Promise<{ access_token: string; refresh_token?: string; expiry_at: string }> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    new URLSearchParams({
      client_id:     process.env.GOOGLE_CLIENT_ID     ?? "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      refresh_token,
      grant_type:    "refresh_token",
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    console.error("[refreshGoogleToken] failed:", res.status, body);
    // 400 means the refresh token was revoked or expired (e.g. app in Testing mode).
    // Signal the caller to clear stale tokens so the user can reconnect.
    const err = new Error(`Google token refresh failed: ${res.status}`);
    (err as Error & { googleError?: string; shouldDisconnect?: boolean }).googleError = body?.error ?? String(res.status);
    (err as Error & { shouldDisconnect?: boolean }).shouldDisconnect = res.status === 400;
    throw err;
  }
  const json = await res.json();
  return {
    access_token: json.access_token,
    expiry_at:    new Date(Date.now() + json.expires_in * 1000).toISOString(),
  };
}

async function refreshMicrosoftToken(
  refresh_token: string,
): Promise<{ access_token: string; refresh_token?: string; expiry_at: string }> {
  const res = await fetch(
    "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    {
      method:  "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:    new URLSearchParams({
        client_id:     process.env.MICROSOFT_CLIENT_ID     ?? "",
        client_secret: process.env.MICROSOFT_CLIENT_SECRET ?? "",
        refresh_token,
        grant_type:    "refresh_token",
        scope:         "https://graph.microsoft.com/Mail.Send offline_access",
      }),
    },
  );
  if (!res.ok) throw new Error(`Microsoft token refresh failed: ${res.status}`);
  const json = await res.json();
  return {
    access_token:  json.access_token,
    refresh_token: json.refresh_token,
    expiry_at:     new Date(Date.now() + json.expires_in * 1000).toISOString(),
  };
}

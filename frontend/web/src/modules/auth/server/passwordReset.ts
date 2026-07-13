/**
 * Password-reset sending.
 *
 * SSO-only detection (telling a Google-only user there's no password to
 * reset, instead of a silent no-op) was reverted here — it previously called
 * admin.auth.admin.generateLink({ type: "recovery" }) to inspect identities
 * before calling resetPasswordForEmail(). Both represent "mint a recovery
 * token" to GoTrue, and they appear to share the same per-identity cooldown:
 * every single request was hitting "For security purposes, you can only
 * request this after 59 seconds" on the SECOND call, unconditionally — a
 * self-inflicted lockout on every attempt, not a real rate limit being hit
 * by the user. There's no cheap alternative in the stable admin API
 * (listUsers() only paginates, no email filter) — reintroducing the
 * SSO-only check needs either a Postgres function reading auth.identities
 * directly, or confirmation from Supabase that a different check doesn't
 * share the recovery cooldown. Tracked as a follow-up, not blocking the
 * core reset flow.
 */

import { createAdminClient } from "@/lib/supabase/admin";

export interface PasswordResetResult {
  ssoOnly: boolean;
  error?: string;
}

export async function sendPasswordReset(
  email: string,
  redirectTo: string,
  captchaToken: string | null,
): Promise<PasswordResetResult> {
  const admin = createAdminClient();

  const { error } = await admin.auth.resetPasswordForEmail(email, {
    redirectTo,
    captchaToken: captchaToken ?? undefined,
  });

  if (error) {
    return { ssoOnly: false, error: error.message };
  }
  return { ssoOnly: false };
}

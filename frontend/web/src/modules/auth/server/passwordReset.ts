/**
 * Password-reset with SSO-only detection.
 *
 * A user who signed up via Google has no email/password identity — sending
 * them a "reset your password" email is pointless, and Supabase silently
 * no-ops for it the same way it does for a non-existent email, leaving the
 * user staring at "check your inbox" forever with no way to know why.
 *
 * Identity is checked via check_user_auth_methods() (migration 081) — a
 * read-only Postgres function, NOT the Auth Admin API. An earlier attempt
 * used admin.auth.admin.generateLink({ type: "recovery" }) for this same
 * check; that shares GoTrue's per-identity recovery-token cooldown with
 * resetPasswordForEmail(), so every request was throttling itself on the
 * second call, permanently (production bug, reverted). The RPC never
 * touches GoTrue's recovery flow, so no such conflict is possible.
 *
 * Big-company products (Google, GitHub, Notion, ...) accept a small,
 * deliberate amount of account-existence leakage here: once we already know
 * an account exists, telling the user which sign-in method it uses is far
 * more useful than staying silent. We do NOT extend that leakage to "does
 * this email have an account at all" — the two ambiguous cases (no account /
 * account has a password) return the identical `ssoOnly: false` response, so
 * only the genuinely-actionable case is distinguished.
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

  const { data: methodsData } = await admin
    .rpc("check_user_auth_methods", { p_email: email })
    .single();
  const methods = methodsData as { user_exists: boolean; has_password: boolean } | null;

  if (methods?.user_exists && !methods.has_password) {
    // Account exists, no password identity — nothing to reset, and
    // resetPasswordForEmail would no-op anyway. Don't bother sending.
    return { ssoOnly: true };
  }

  // Covers both "account doesn't exist" and "account has a password" —
  // identical code path so the two remain indistinguishable to the caller.
  const { error } = await admin.auth.resetPasswordForEmail(email, {
    redirectTo,
    captchaToken: captchaToken ?? undefined,
  });

  if (error) {
    return { ssoOnly: false, error: error.message };
  }
  return { ssoOnly: false };
}

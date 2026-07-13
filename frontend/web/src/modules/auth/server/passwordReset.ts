/**
 * Password-reset with SSO-only detection.
 *
 * A user who signed up via Google has no email/password identity — sending
 * them a "reset your password" email is pointless, and Supabase silently
 * no-ops for it the same way it does for a non-existent email, leaving the
 * user staring at "check your inbox" forever with no way to know why.
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

  // generateLink both checks existence and returns identities, without
  // sending anything itself — exactly what we need for the SSO-only check.
  const { data: linkData } = await admin.auth.admin.generateLink({
    type: "recovery",
    email,
  });

  const identities = linkData?.user?.identities ?? [];
  const ssoOnly = linkData?.user != null && !identities.some((i) => i.provider === "email");

  if (ssoOnly) {
    // Don't bother sending — there's no password to reset, and Supabase
    // would no-op the send anyway.
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

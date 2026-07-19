/**
 * SSO-only detection for forgot-password — the CHECK only, not the send.
 *
 * The actual resetPasswordForEmail() call must run client-side (browser
 * anon-key client), not here. Supabase's recovery flow is PKCE-based: it
 * generates a code_verifier and stores it wherever the request originated,
 * then the emailed link carries a `code` that must be exchanged by that same
 * origin. A prior version called resetPasswordForEmail() from this
 * server-side admin client — the code_verifier ended up in a throwaway
 * server request context, never in the user's browser, so the link always
 * failed exchange later ("invalid or expired") regardless of how fast the
 * user clicked it. This function ONLY answers "does this email have a
 * password identity" via a read-only DB function (migration 081) — no
 * GoTrue call at all, so it can safely run server-side without touching
 * either the recovery cooldown or PKCE state.
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

export async function checkSsoOnly(email: string): Promise<boolean> {
  const admin = createAdminClient();
  const { data } = await admin
    .rpc("check_user_auth_methods", { p_email: email })
    .single();
  const methods = data as { user_exists: boolean; has_password: boolean } | null;
  return !!(methods?.user_exists && !methods.has_password);
}

/**
 * Invite-gated, server-side account creation.
 *
 * WHY THIS EXISTS
 * ───────────────
 * The old flow validated the invite client-side and then called
 * `supabase.auth.signInWithOtp({ shouldCreateUser: true })` with the PUBLIC
 * anon key. That meant the invite gate was advisory only: anyone could call
 * Supabase signup directly with the anon key (it ships in the browser bundle)
 * and self-register. This service moves account creation server-side, behind an
 * atomic invite claim, using the service-role admin API.
 *
 * ⚠️ REQUIRED CONFIG FOR THIS TO ACTUALLY ENFORCE THE GATE ⚠️
 * You MUST disable public email signups in Supabase:
 *   Dashboard → Authentication → Providers → Email → "Allow new users" = OFF
 * Otherwise the anon-key `signInWithOtp({ shouldCreateUser: true })` path is
 * still open and this route is just a nicer front door, not a lock.
 * (admin.auth.admin.inviteUserByEmail below bypasses that project setting —
 *  it's the service-role path — so disabling public signups does not break it.)
 *
 * ⚠️ NEEDS TESTING BEFORE DEPLOY ⚠️
 * inviteUserByEmail sends an invite-type link. Confirm /auth/confirm handles
 * the resulting redirect (it now accepts both `code` and `token_hash`+`type`).
 * Verify the end-to-end click-through against your Supabase project before
 * shipping — link formats depend on the project's auth flow config.
 */

import { createAdminClient } from "@/lib/supabase/admin";

export type SignupResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

/**
 * Atomically claim an invite code, then create the account + send the
 * confirmation email via the service-role admin API.
 *
 * @param email     already trimmed + lowercased + format-validated by the route
 * @param code      already trimmed + uppercased by the route
 * @param originUrl fallback app origin when NEXT_PUBLIC_APP_URL is unset
 */
export async function signupWithInvite(
  email: string,
  code: string,
  originUrl: string,
): Promise<SignupResult> {
  const admin = createAdminClient();

  // Atomically claim the invite. The WHERE clause (is_active = true AND
  // used_by IS NULL) means two concurrent signups can't both win the same code:
  // only the first UPDATE flips is_active to false and returns a row.
  const { data: claimed, error: claimErr } = await admin
    .from("invite_codes")
    .update({ is_active: false, used_at: new Date().toISOString() })
    .eq("code", code)
    .eq("is_active", true)
    .is("used_by", null)
    .select("code")
    .maybeSingle();

  if (claimErr) {
    console.error("[auth/signup] invite claim error:", claimErr.message);
    return { ok: false, status: 500, error: "Could not start signup. Try again." };
  }
  if (!claimed) {
    return { ok: false, status: 400, error: "Invalid or already-used invite code" };
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? originUrl;

  // Create the user + send the confirmation email via the service-role admin
  // API. user_metadata.invite_code is stored for audit; /auth/confirm stamps
  // invite_codes.used_by once the session is established.
  const { error: inviteErr } = await admin.auth.admin.inviteUserByEmail(email, {
    redirectTo: `${appUrl}/auth/confirm?invite=${encodeURIComponent(code)}`,
    data: { invite_code: code },
  });

  if (inviteErr) {
    // Release the claim so a typo'd / already-registered email doesn't
    // permanently burn a valid invite code.
    await admin
      .from("invite_codes")
      .update({ is_active: true, used_at: null })
      .eq("code", code)
      .is("used_by", null);

    console.error("[auth/signup] inviteUserByEmail failed:", inviteErr.message);
    const already = /already|exists|registered/i.test(inviteErr.message);
    return {
      ok: false,
      status: already ? 409 : 502,
      error: already
        ? "That email is already registered — try signing in instead."
        : "Could not start signup. Please try again.",
    };
  }

  return { ok: true };
}

/**
 * Auth-link confirmation — Supabase redirects here after the user clicks a
 * magic-link, signup-confirmation, or password-recovery link. Exchanges the
 * code for a session and emits a login event.
 */

import { headers } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { emitEvent, parseDevice } from "@/lib/admin/events";

/**
 * Does this exchange represent a password-recovery link?
 *
 * `otpType` is Supabase's query-param signal (`?type=recovery`) — present for
 * the legacy hash-fragment flow and for verifyOtp's token_hash flow, but
 * ABSENT for the PKCE/code-exchange flow this app uses for password resets
 * (see the 2026-08-09 fix: exchangeCodeForSession never gets `type=recovery`
 * in its query string). `redirectType` is that flow's own signal instead —
 * returned by exchangeCodeForSession at runtime (sourced from the stored
 * code_verifier cookie) but NOT part of the SDK's public TypeScript type, so
 * callers must read it via a cast; see the call site.
 *
 * Without this, a recovery link falls through to the "no type = OAuth
 * callback" branch, landing an authenticated recovery session on `/` — which
 * an incomplete-entitlement account then gets bounced from straight to
 * /onboarding/plan instead of ever reaching the password form.
 */
export function isRecoveryLink(otpType: string | null, redirectType: string | null | undefined): boolean {
  return otpType === "recovery" || redirectType === "recovery";
}

export async function handleAuthConfirm(request: NextRequest): Promise<NextResponse> {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const otpType = searchParams.get("type"); // 'invite' | 'magiclink' | 'signup' | 'recovery' | 'email'

  if (!code && !tokenHash) {
    // Some Supabase link types (password recovery in particular) deliver the
    // session as a URL hash fragment (#access_token=...&type=recovery)
    // instead of a query param. Hash fragments are never sent to the server
    // — the browser strips them before the request even leaves — so a plain
    // server redirect here would silently lose them and just bounce to
    // login with no explanation. Instead, respond with a tiny client-side
    // page that CAN read location.hash (it's the exact page the browser
    // just navigated to) and forward it on as a real client-side
    // navigation, which preserves the hash. lib/supabase/client.ts's
    // browser client auto-consumes access_token/refresh_token from the URL
    // hash on mount (detectSessionInUrl, the @supabase/ssr default), so the
    // recovery session ends up established once we land there.
    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body>
<script>
  var hash = window.location.hash || "";
  if (hash.includes("access_token") && hash.includes("type=recovery")) {
    window.location.replace("/auth/update-password" + hash);
  } else if (hash.includes("access_token")) {
    window.location.replace("/" + hash);
  } else {
    window.location.replace("/auth/login?error=missing_code");
  }
</script>
</body></html>`;
    return new NextResponse(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  const supabase = await createClient();

  // Establish the session from whichever link format Supabase produced:
  //  - PKCE / OTP magic links carry `code`     → exchangeCodeForSession
  //  - invite / email links carry `token_hash` → verifyOtp
  const { data, error } = code
    ? await supabase.auth.exchangeCodeForSession(code)
    : await supabase.auth.verifyOtp({
        token_hash: tokenHash!,
        type: (otpType as "invite" | "magiclink" | "signup" | "recovery" | "email") ?? "email",
      });
  if (error) {
    return NextResponse.redirect(`${origin}/auth/login?error=exchange_failed`);
  }

  // exchangeCodeForSession's public type only declares { user, session } —
  // `redirectType` is undocumented in @supabase/auth-js's TypeScript types but
  // real at runtime (its own JSDoc example shows `redirectType: null`). This
  // cast reads that undocumented-but-real field; see isRecoveryLink's comment
  // for why it's the only signal available for this link type.
  const redirectType = (data as { redirectType?: string | null } | null)?.redirectType;

  // Password recovery is the one link type that must NOT end in a sign-out —
  // the user doesn't know their old password (that's why they're here), so
  // they need the session this link just established to actually set a new
  // one. Send them straight to the update-password screen instead of the
  // signup/login stamping-and-signout path below.
  if (isRecoveryLink(otpType, redirectType)) {
    return NextResponse.redirect(`${origin}/auth/update-password`);
  }

  // Emit login event for admin activity tracking (fire-and-forget).
  const { data: { user: sessionUser } } = await supabase.auth.getUser();
  if (sessionUser) {
    const reqHeaders = await headers();
    const ip     = reqHeaders.get("x-forwarded-for")?.split(",")[0]?.trim() ?? undefined;
    const ua     = reqHeaders.get("user-agent") ?? null;
    const device = parseDevice(ua) ?? undefined;
    // Country/city could be added via ip-api.com lookup here in a future phase
    void emitEvent({
      userId:    sessionUser.id,
      eventType: "login",
      metadata:  { type: otpType ?? "magiclink" },
      ip,
      device,
    });
  }

  // OAuth callbacks (Google) arrive here with `code` but no `type` param —
  // the session is already valid from the OAuth exchange, so send the user
  // straight to the dashboard. Magic-link / signup-confirmation links carry
  // `type` and should land on the login screen for a deliberate sign-in.
  if (!otpType) {
    return NextResponse.redirect(`${origin}/`);
  }

  // exchangeCodeForSession/verifyOtp above already established a session, but
  // we want the user to land on the login screen and sign in deliberately
  // (clearer than silently dropping them into the dashboard from an email
  // click) — sign back out before redirecting. Middleware bounces logged-in
  // users away from /auth/login, so this sign-out is required for the
  // redirect target to actually be reachable.
  await supabase.auth.signOut();

  return NextResponse.redirect(`${origin}/auth/login?confirmed=1`);
}

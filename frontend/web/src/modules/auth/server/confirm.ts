/**
 * Auth-link confirmation — Supabase redirects here after the user clicks a
 * magic/invite/signup link. Exchanges the code for a session, stamps the
 * invite code (when present), and emits a login event.
 */

import { headers } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { emitEvent, parseDevice } from "@/lib/admin/events";

export async function handleAuthConfirm(request: NextRequest): Promise<NextResponse> {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const otpType = searchParams.get("type"); // 'invite' | 'magiclink' | 'signup' | 'recovery' | 'email'
  const inviteCode = searchParams.get("invite");

  if (!code && !tokenHash) {
    return NextResponse.redirect(`${origin}/auth/login?error=missing_code`);
  }

  const supabase = await createClient();

  // Establish the session from whichever link format Supabase produced:
  //  - PKCE / OTP magic links carry `code`     → exchangeCodeForSession
  //  - invite / email links carry `token_hash` → verifyOtp
  const { error } = code
    ? await supabase.auth.exchangeCodeForSession(code)
    : await supabase.auth.verifyOtp({
        token_hash: tokenHash!,
        type: (otpType as "invite" | "magiclink" | "signup" | "recovery" | "email") ?? "email",
      });
  if (error) {
    return NextResponse.redirect(`${origin}/auth/login?error=exchange_failed`);
  }

  // If this is a signup (invite code present), stamp who used the code.
  // The code was already consumed (is_active=false) when /api/auth/signup
  // claimed it, so match on used_by IS NULL to record the user id now.
  if (inviteCode) {
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      await supabase
        .from("invite_codes")
        .update({ used_by: user.id, used_at: new Date().toISOString(), is_active: false })
        .eq("code", inviteCode)
        .is("used_by", null);

      await supabase
        .from("users")
        .update({ invite_code_used: inviteCode })
        .eq("id", user.id);
    }
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

  return NextResponse.redirect(`${origin}/dashboard`);
}

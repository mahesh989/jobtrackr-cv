/**
 * GET /api/auth/email/google/callback
 * Handles Google OAuth callback: exchanges code for tokens, fetches the user's
 * Gmail address, encrypts + saves to email_integrations, then redirects to
 * /dashboard/integrations.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient }              from "@/lib/supabase/server";
import { saveTokens }                from "@/lib/email/tokens";
import { cookies }                   from "next/headers";

export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL("/auth/login", req.url));

  const { searchParams } = req.nextUrl;
  const code  = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";

  if (error || !code) {
    return NextResponse.redirect(
      `${appUrl}/dashboard/settings/profile?email_error=${encodeURIComponent(error ?? "no_code")}`,
    );
  }

  // Verify CSRF state
  const jar          = await cookies();
  const storedState  = jar.get("email_oauth_state")?.value;
  jar.delete("email_oauth_state");

  if (!storedState || storedState !== state) {
    return NextResponse.redirect(
      `${appUrl}/dashboard/settings/profile?email_error=invalid_state`,
    );
  }

  const clientId     = process.env.GOOGLE_CLIENT_ID     ?? "";
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? "";
  const redirectUri  = `${appUrl}/api/auth/email/google/callback`;

  // Exchange code for tokens
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    new URLSearchParams({
      client_id:     clientId,
      client_secret: clientSecret,
      redirect_uri:  redirectUri,
      grant_type:    "authorization_code",
      code,
    }),
  });

  if (!tokenRes.ok) {
    return NextResponse.redirect(
      `${appUrl}/dashboard/settings/profile?email_error=token_exchange_failed`,
    );
  }

  const tokenJson = await tokenRes.json();
  const { access_token, refresh_token, expires_in } = tokenJson;
  if (!access_token || !refresh_token) {
    return NextResponse.redirect(
      `${appUrl}/dashboard/settings/profile?email_error=missing_tokens`,
    );
  }

  // Fetch the user's Gmail address
  const profileRes = await fetch(
    "https://www.googleapis.com/oauth2/v2/userinfo",
    { headers: { Authorization: `Bearer ${access_token}` } },
  );
  const profileJson = profileRes.ok ? await profileRes.json() : {};
  const email = profileJson.email ?? user.email ?? "";

  try {
    await saveTokens(user.id, {
      access_token,
      refresh_token,
      expiry_at: new Date(Date.now() + expires_in * 1000).toISOString(),
      email,
      provider:  "google",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[google/callback] saveTokens failed:", msg);
    return NextResponse.redirect(
      `${appUrl}/dashboard/settings/profile?email_error=${encodeURIComponent("save_failed:" + msg.slice(0, 120))}`,
    );
  }

  return NextResponse.redirect(
    `${appUrl}/dashboard/settings/profile?email_connected=google`,
  );
}

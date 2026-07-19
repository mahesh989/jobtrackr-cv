/**
 * GET /api/auth/email/outlook/callback
 * Handles Microsoft OAuth callback: exchanges code for tokens, fetches the
 * user's Outlook address, encrypts + saves to email_integrations.
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
      `${appUrl}/settings/profile?email_error=${encodeURIComponent(error ?? "no_code")}`,
    );
  }

  const jar         = await cookies();
  const storedState = jar.get("email_oauth_state")?.value;
  jar.delete("email_oauth_state");

  if (!storedState || storedState !== state) {
    return NextResponse.redirect(
      `${appUrl}/settings/profile?email_error=invalid_state`,
    );
  }

  const clientId     = process.env.MICROSOFT_CLIENT_ID     ?? "";
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET ?? "";
  const redirectUri  = `${appUrl}/api/auth/email/outlook/callback`;

  const tokenRes = await fetch(
    "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    {
      method:  "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:    new URLSearchParams({
        client_id:     clientId,
        client_secret: clientSecret,
        redirect_uri:  redirectUri,
        grant_type:    "authorization_code",
        scope:         "https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/User.Read offline_access",
        code,
      }),
    },
  );

  if (!tokenRes.ok) {
    return NextResponse.redirect(
      `${appUrl}/settings/profile?email_error=token_exchange_failed`,
    );
  }

  const tokenJson = await tokenRes.json();
  const { access_token, refresh_token, expires_in } = tokenJson;
  if (!access_token || !refresh_token) {
    return NextResponse.redirect(
      `${appUrl}/settings/profile?email_error=missing_tokens`,
    );
  }

  // Fetch Outlook email address via Graph API
  const profileRes  = await fetch("https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName", {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  const profileJson = profileRes.ok ? await profileRes.json() : {};
  const email       = profileJson.mail ?? profileJson.userPrincipalName ?? user.email ?? "";

  try {
    await saveTokens(user.id, {
      access_token,
      refresh_token,
      expiry_at: new Date(Date.now() + expires_in * 1000).toISOString(),
      email,
      provider:  "microsoft",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[outlook/callback] saveTokens failed:", msg);
    return NextResponse.redirect(
      `${appUrl}/settings/profile?email_error=${encodeURIComponent("save_failed:" + msg.slice(0, 120))}`,
    );
  }

  return NextResponse.redirect(
    `${appUrl}/settings/profile?email_connected=outlook`,
  );
}

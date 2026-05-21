/**
 * GET /api/auth/email/google
 * Initiates the Google OAuth 2.0 flow for Gmail send-only access.
 * Stores a CSRF state token in a short-lived cookie, then redirects to Google.
 *
 * Required env vars:
 *   GOOGLE_CLIENT_ID
 *   NEXT_PUBLIC_APP_URL   (e.g. https://jobtrackr.app)
 */

import { NextResponse }  from "next/server";
import { createClient }  from "@/lib/supabase/server";
import { randomBytes }   from "crypto";
import { cookies }       from "next/headers";

const SCOPE = "https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/userinfo.email";

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const clientId   = process.env.GOOGLE_CLIENT_ID;
  const appUrl     = process.env.NEXT_PUBLIC_APP_URL;
  if (!clientId || !appUrl) {
    return NextResponse.json({ error: "Google OAuth not configured" }, { status: 500 });
  }

  const state       = randomBytes(16).toString("hex");
  const redirectUri = `${appUrl}/api/auth/email/google/callback`;

  // Store state in a short-lived (10 min) httpOnly cookie
  const jar = await cookies();
  jar.set("email_oauth_state", state, {
    httpOnly: true,
    secure:   true,
    sameSite: "lax",
    maxAge:   600,
    path:     "/",
  });

  const params = new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  redirectUri,
    response_type: "code",
    scope:         SCOPE,
    access_type:   "offline",
    prompt:        "consent",   // ensures refresh_token is always returned
    state,
  });

  return NextResponse.redirect(
    `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
  );
}

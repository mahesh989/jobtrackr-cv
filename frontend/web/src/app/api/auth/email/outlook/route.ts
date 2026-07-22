/**
 * GET /api/auth/email/outlook
 * Initiates Microsoft OAuth 2.0 flow for Outlook Mail.Send access.
 *
 * Required env vars:
 *   MICROSOFT_CLIENT_ID
 *   NEXT_PUBLIC_APP_URL
 */

import { NextResponse } from "next/server";
import { randomBytes }  from "crypto";
import { cookies }      from "next/headers";
import { withUser } from "@/lib/api-utils";

const SCOPE = "https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/User.Read offline_access";

export const GET = withUser(async () => {

  const clientId = process.env.MICROSOFT_CLIENT_ID;
  const appUrl   = process.env.NEXT_PUBLIC_APP_URL;
  if (!clientId || !appUrl) {
    return NextResponse.json({ error: "Outlook OAuth not configured" }, { status: 500 });
  }

  const state       = randomBytes(16).toString("hex");
  const redirectUri = `${appUrl}/api/auth/email/outlook/callback`;

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
    state,
  });

  return NextResponse.redirect(
    `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params}`,
  );
});

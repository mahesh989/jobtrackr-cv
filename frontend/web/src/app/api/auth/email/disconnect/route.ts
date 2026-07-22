/**
 * POST /api/auth/email/disconnect
 * Removes the user's email_integrations row (revokes local tokens).
 * Does NOT revoke the OAuth grant on Google/Microsoft's side — the user
 * must do that from their account settings if desired.
 */

import { NextResponse } from "next/server";
import { deleteTokens } from "@/lib/email/tokens";
import { withUser } from "@/lib/api-utils";

export const POST = withUser(async (_req, _ctx, { user }) => {

  await deleteTokens(user.id);
  return NextResponse.json({ disconnected: true });
});

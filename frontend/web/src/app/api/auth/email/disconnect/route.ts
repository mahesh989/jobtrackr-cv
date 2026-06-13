/**
 * POST /api/auth/email/disconnect
 * Removes the user's email_integrations row (revokes local tokens).
 * Does NOT revoke the OAuth grant on Google/Microsoft's side — the user
 * must do that from their account settings if desired.
 */

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { deleteTokens } from "@/lib/email/tokens";

export async function POST() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  await deleteTokens(user.id);
  return NextResponse.json({ disconnected: true });
}

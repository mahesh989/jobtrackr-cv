/**
 * Invite-code validation for the (currently dormant) invite-gated signup flow.
 * Admin-side invite management (generate/revoke) lives in lib/actions/invites.ts
 * — that is an admin-domain concern, not auth.
 */

import { createClient } from "@/lib/supabase/server";

export type InviteValidation =
  | { ok: true }
  | { ok: false; status: number; error: string };

/** Check an invite code exists, is active, and is unused. Read-only. */
export async function validateInviteCode(code: string): Promise<InviteValidation> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("invite_codes")
    .select("code, is_active, used_by")
    .eq("code", code)
    .single();

  if (error || !data) {
    return { ok: false, status: 400, error: "Invalid invite code" };
  }
  if (!data.is_active || data.used_by) {
    return { ok: false, status: 400, error: "Invite code has already been used" };
  }

  return { ok: true };
}

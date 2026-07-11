import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isUserVisaStatus } from "@/lib/eligibility";

/**
 * GET/PATCH /api/user/visa-status — the user's working-rights situation
 * (user_preferences.contact_details.visa_status). A user-level fact like
 * role_families ("applies to all CVs"), NOT per-profile. Drives the
 * pipeline's stage-10b eligibility filter and the job-card badge.
 * Uses the caller's own Supabase client (RLS own-read / own-update).
 */

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data } = await supabase
    .from("user_preferences")
    .select("contact_details")
    .eq("user_id", user.id)
    .maybeSingle();

  const vs = (data?.contact_details as { visa_status?: string } | null)?.visa_status ?? null;
  return NextResponse.json({ visa_status: isUserVisaStatus(vs) ? vs : null });
}

export async function PATCH(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const visaStatus = (body as { visa_status?: unknown })?.visa_status;
  // null = explicit "clear my status" (badge + fetch filter turn off).
  if (visaStatus !== null && !isUserVisaStatus(visaStatus)) {
    return NextResponse.json(
      { error: "visa_status must be citizen | pr | temp_unrestricted | student_capped | needs_sponsorship | null" },
      { status: 400 }
    );
  }

  // Read-merge-write on the contact_details jsonb — preserves role_families
  // and every other key. The row exists for any user who completed My CV;
  // if it doesn't yet, there's nothing to attach the status to.
  const { data: row } = await supabase
    .from("user_preferences")
    .select("contact_details")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!row) {
    return NextResponse.json(
      { error: "Complete My CV setup first — no preferences row exists yet" },
      { status: 409 }
    );
  }

  const merged = { ...((row.contact_details as Record<string, unknown> | null) ?? {}) };
  if (visaStatus === null) delete merged.visa_status;
  else merged.visa_status = visaStatus;

  const { error } = await supabase
    .from("user_preferences")
    .update({ contact_details: merged })
    .eq("user_id", user.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ visa_status: visaStatus });
}

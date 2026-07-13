import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  isSetupComplete,
  firstIncompleteStep,
} from "@/lib/setupSteps";
import type { SetupStatus } from "@/lib/setupStatus";

/**
 * Lightweight setup-status check for the client-side setup gate.
 * Returns { complete: boolean, step: number } — step is 1-based index of the
 * first incomplete step. Used by SetupGateClient to redirect correctly.
 */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ complete: true, step: 1 });

  const [prefRes, cvRes, aiRes] = await Promise.all([
    supabase
      .from("user_preferences")
      .select("contact_details")
      .eq("user_id", user.id)
      .maybeSingle(),
    supabase
      .from("cv_versions")
      .select("id")
      .eq("user_id", user.id)
      .limit(1),
    createAdminClient()
      .from("platform_ai_settings")
      .select("status")
      .eq("is_active", true)
      .maybeSingle(),
  ]);

  const cd = (prefRes.data?.contact_details ?? {}) as Record<string, unknown>;
  const status: SetupStatus = {
    billing: true, // subscription gate in layout already handles this
    profile: !!(cd.name && cd.address && cd.phone),
    cv: (cvRes.data?.length ?? 0) > 0,
    voice: false,
    aiKey: (aiRes.data as { status: string | null } | null)?.status === "valid",
    email: false,
    apify: false,
    searchProfile: false,
    hasAnyJob: false,
  };

  const complete = isSetupComplete(status);
  // firstIncompleteStep returns 0-based; API returns 1-based for the URL param.
  const step = complete ? 1 : firstIncompleteStep(status) + 1;

  return NextResponse.json({ complete, step });
}

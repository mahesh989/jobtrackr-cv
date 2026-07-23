import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSetupStatus } from "@/lib/setupStatus";
import { isSetupComplete, firstIncompleteStep, missingRequiredTitles } from "@/lib/setupSteps";

/**
 * Lightweight setup-status check for the client-side setup gate AND the
 * "Finish setup" validation popup.
 * Returns { complete, step, missingRequired } — step is the 1-based index of
 * the first incomplete step (required steps win); missingRequired lists the
 * titles of every required step still outstanding (empty when complete).
 */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ complete: true, step: 1, missingRequired: [] });

  const { data: profileRows } = await supabase
    .from("search_profiles").select("id");
  const ids = ((profileRows ?? []) as Array<{ id: string }>).map((p) => p.id);

  // Billing gate is already enforced by the layout — pass true here so this
  // lightweight check doesn't have to re-query subscriptions.
  const status = await getSetupStatus(user.id, ids, true);

  const complete = isSetupComplete(status);
  // firstIncompleteStep returns 0-based; API returns 1-based for the URL param.
  const step = complete ? 1 : firstIncompleteStep(status) + 1;
  const missingRequired = complete ? [] : missingRequiredTitles(status);

  return NextResponse.json({ complete, step, missingRequired });
}

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSetupStatus } from "@/lib/setupStatus";
import { isSetupComplete, firstIncompleteStep } from "@/lib/setupSteps";

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

  const { data: profileRows } = await supabase
    .from("search_profiles").select("id");
  const ids = ((profileRows ?? []) as Array<{ id: string }>).map((p) => p.id);

  // Billing gate is already enforced by the layout — pass true here so this
  // lightweight check doesn't have to re-query subscriptions.
  const status = await getSetupStatus(user.id, ids, true);

  const complete = isSetupComplete(status);
  // firstIncompleteStep returns 0-based; API returns 1-based for the URL param.
  const step = complete ? 1 : firstIncompleteStep(status) + 1;

  return NextResponse.json({ complete, step });
}

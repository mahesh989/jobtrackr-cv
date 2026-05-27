/**
 * /dashboard/beta/sources — per-source pipeline coverage A/B/C/D tool.
 *
 * Runs each source adapter in isolation (dry-run, no DB writes) and reports
 * per-stage counts: fetched → after_url_dedup → after_keyword → after_smart →
 * after_dedup → would_save, plus full/thin JD counts and a sample of titles
 * per source. Cross-source overlap matrix + total unique computed once all
 * sources complete.
 *
 * Server component — auth gate + render client. State lives in the client.
 */

import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { SourceEvalClient } from "./SourceEvalClient";

export const metadata = { title: "Source coverage A/B test — JobTrackr" };

export default async function SourceBetaPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");
  return <SourceEvalClient />;
}

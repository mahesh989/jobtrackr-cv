/**
 * /dashboard/beta/job-board — UX preview of the redesigned job table.
 *
 * Pure UI mock with sample rows. No DB reads, no actions wired up.
 * Safe to ship to prod; nothing here can mutate state.
 */

import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { JobBoardBetaClient } from "./JobBoardBetaClient";

export const metadata = { title: "Job board redesign (beta) — JobTrackr" };

export default async function JobBoardBetaPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");
  return <JobBoardBetaClient />;
}

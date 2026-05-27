/**
 * /dashboard/beta/job-feed — opinionated "smart feed" preview of the
 * job board. Ditches the table entirely in favour of action-oriented
 * sections + a distance ribbon. Pure UI mock; no DB hit.
 */

import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { JobFeedBetaClient } from "./JobFeedBetaClient";

export const metadata = { title: "Job feed redesign (beta) — JobTrackr" };

export default async function JobFeedBetaPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");
  return <JobFeedBetaClient />;
}

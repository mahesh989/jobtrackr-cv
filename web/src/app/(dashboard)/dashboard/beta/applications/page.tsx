/**
 * /dashboard/beta/applications — redesigned Applications outbox preview.
 *
 * Collapses the old 5-stage flow (Pool → Ready to review → Ready to apply →
 * Sent → Archived) into a 4-stage flow where the "Ready to send" card IS the
 * review surface (no modal, no review/apply tab split):
 *
 *   Application pool   — triage gate. Expand to quick-peek the cover letter +
 *                        tailored CV, then "Move forward" (optional contact
 *                        email) or Dismiss.
 *   Ready to send      — the big card. Inline-editable subject + body, channel
 *                        chip, one channel-adaptive primary action
 *                        (Send email  OR  Copy email + Apply now).
 *   Sent / Applied     — outcomes.
 *   Archived           — dismissed.
 *
 * Pure UI mock, no backend. Gated on login only so the founder can eyeball it.
 */

import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { ApplicationsRedesignClient } from "./ApplicationsRedesignClient";

export const metadata = { title: "Applications redesign (beta) — JobTrackr" };

export default async function ApplicationsBetaPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");
  return <ApplicationsRedesignClient />;
}

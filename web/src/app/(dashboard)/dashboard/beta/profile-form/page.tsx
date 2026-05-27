/**
 * /dashboard/beta/profile-form — UX preview of the redesigned profile editor.
 *
 * Renders the new layout (see ProfileFormBetaClient) without wiring it to
 * createProfile/updateProfile. Safe to ship to production: nothing is saved.
 */

import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { ProfileFormBetaClient } from "./ProfileFormBetaClient";

export const metadata = { title: "ProfileForm redesign (beta) — JobTrackr" };

export default async function ProfileFormBetaPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");
  return <ProfileFormBetaClient />;
}

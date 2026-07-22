/**
 * getSetupStatus — server-side detection of how far a user has progressed
 * through first-run setup. Powers the setup wizard (✓ per step) and the
 * dashboard gate (show the guide until the first pipeline run produces data).
 *
 * RLS-scoped tables (user_preferences, cv_versions, voice_profiles, jobs) use
 * the cookie-bound client. Integration tables (email_integrations,
 * user_integrations for apify) are read with the service-role admin client
 * and scoped by user_id. platform_ai_settings is platform-wide (no user_id —
 * the admin-configured AI provider applies to every user).
 */

import { createClient }      from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export type SetupStepKey =
  | "billing" | "details" | "cv" | "voice" | "aiKey" | "email" | "apify" | "searchProfile";

export interface SetupStatus {
  billing:       boolean; // an active subscription row exists (status !== "none")
  details:       boolean; // contact details filled (name + address + phone)
  cv:            boolean; // at least one CV version exists (first upload auto-activates)
  voice:         boolean; // a writing-voice profile exists
  aiKey:         boolean; // the platform AI provider (admin-configured) is active + valid
  email:         boolean; // Gmail/Outlook connected
  apify:         boolean; // Apify token connected
  searchProfile: boolean; // a run has produced jobs (= hasAnyJob)
  hasAnyJob:     boolean; // any job exists across the user's profiles
}

export async function getSetupStatus(
  userId: string,
  profileIds: string[],
  /**
   * Whether the caller already has an active subscription (any status other
   * than "none" — trialing/active/past_due/canceled all count, since the
   * step is "did you pick a plan", not "are you currently paying"). Callers
   * that already compute Entitlement should pass `ent.status !== "none"`
   * rather than have this module re-query the subscriptions table.
   */
  hasBilling: boolean,
): Promise<SetupStatus> {
  const supabase = await createClient();
  const admin    = createAdminClient();
  const hasIds   = profileIds.length > 0;

  const [prefRes, cvRes, voiceRes, aiRes, emailRes, apifyRes, jobRes] = await Promise.all([
    supabase.from("user_preferences").select("contact_details").eq("user_id", userId).maybeSingle(),
    // Any CV in the library counts the step as done — the first upload
    // auto-becomes active, and an inactive CV is still progress the user
    // shouldn't be nagged about.
    supabase.from("cv_versions").select("id").eq("user_id", userId).limit(1),
    supabase.from("voice_profiles").select("user_id").eq("user_id", userId).limit(1),
    admin.from("platform_ai_settings").select("status").eq("is_active", true).maybeSingle(),
    admin.from("email_integrations").select("from_address").eq("user_id", userId).maybeSingle(),
    admin.from("user_integrations").select("provider").eq("user_id", userId).eq("provider", "apify").maybeSingle(),
    hasIds
      ? supabase.from("jobs").select("id", { count: "exact", head: true }).in("profile_id", profileIds)
      : Promise.resolve({ count: 0 }),
  ]);

  const cd      = (prefRes.data?.contact_details ?? {}) as Record<string, unknown>;
  const details = !!(cd.name && cd.address && cd.phone);
  const cv      = (cvRes.data?.length ?? 0) > 0;
  const voice   = (voiceRes.data?.length ?? 0) > 0;
  const aiKey   = (aiRes.data as { status: string | null } | null)?.status === "valid";
  const email   = !!emailRes.data?.from_address;
  const apify   = !!apifyRes.data;
  const hasAnyJob = (((jobRes as { count: number | null }).count) ?? 0) > 0;

  return { billing: hasBilling, details, cv, voice, aiKey, email, apify, searchProfile: hasAnyJob, hasAnyJob };
}

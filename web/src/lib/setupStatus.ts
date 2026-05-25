/**
 * getSetupStatus — server-side detection of how far a user has progressed
 * through first-run setup. Powers the setup wizard (✓ per step) and the
 * dashboard gate (show the guide until the first pipeline run produces data).
 *
 * RLS-scoped tables (user_preferences, cv_versions, voice_profiles, jobs) use
 * the cookie-bound client. Integration tables (user_integrations,
 * email_integrations) are read with the service-role admin client — matching
 * the Integrations page — and every query is scoped by user_id.
 */

import { createClient }      from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export type SetupStepKey =
  | "profile" | "cv" | "voice" | "aiKey" | "email" | "apify" | "searchProfile";

export interface SetupStatus {
  profile:       boolean; // contact details: name + address + phone present
  cv:            boolean; // an active CV version exists
  voice:         boolean; // a writing-voice profile exists
  aiKey:         boolean; // a validated BYOK provider key exists
  email:         boolean; // Gmail/Outlook connected
  apify:         boolean; // Apify token connected
  searchProfile: boolean; // a run has produced jobs (= hasAnyJob)
  hasAnyJob:     boolean; // any job exists across the user's profiles
}

export async function getSetupStatus(
  userId: string,
  profileIds: string[],
): Promise<SetupStatus> {
  const supabase = await createClient();
  const admin    = createAdminClient();
  const hasIds   = profileIds.length > 0;

  const [prefRes, cvRes, voiceRes, aiRes, emailRes, apifyRes, jobRes] = await Promise.all([
    supabase.from("user_preferences").select("contact_details").eq("user_id", userId).maybeSingle(),
    supabase.from("cv_versions").select("id").eq("user_id", userId).eq("is_active", true).limit(1),
    supabase.from("voice_profiles").select("user_id").eq("user_id", userId).limit(1),
    admin.from("user_integrations").select("provider, status").eq("user_id", userId)
      .in("provider", ["anthropic", "openai", "deepseek"]),
    admin.from("email_integrations").select("from_address").eq("user_id", userId).maybeSingle(),
    admin.from("user_integrations").select("provider").eq("user_id", userId).eq("provider", "apify").maybeSingle(),
    hasIds
      ? supabase.from("jobs").select("id", { count: "exact", head: true }).in("profile_id", profileIds)
      : Promise.resolve({ count: 0 }),
  ]);

  const cd      = (prefRes.data?.contact_details ?? {}) as Record<string, unknown>;
  const profile = !!(cd.name && cd.address && cd.phone);
  const cv      = (cvRes.data?.length ?? 0) > 0;
  const voice   = (voiceRes.data?.length ?? 0) > 0;
  const aiKey   = ((aiRes.data ?? []) as { status: string }[]).some((r) => r.status === "valid");
  const email   = !!emailRes.data?.from_address;
  const apify   = !!apifyRes.data;
  const hasAnyJob = (((jobRes as { count: number | null }).count) ?? 0) > 0;

  return { profile, cv, voice, aiKey, email, apify, searchProfile: hasAnyJob, hasAnyJob };
}

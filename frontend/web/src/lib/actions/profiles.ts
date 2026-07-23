"use server";

import { redirect } from "next/navigation";
import { revalidatePath, revalidateTag } from "next/cache";
import { assertCanCreateProfile, getEntitlement } from "@/lib/billing/entitlements";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSetupStatus } from "@/lib/setupStatus";
import { isSetupComplete } from "@/lib/setupSteps";
import { authedClient, triggerScheduleSync, extractAdzunaFields, extractAutomationFields, extractSourceFields, extractSettingFilter } from "./_helpers";

/**
 * Get the user's "Saved Jobs" profile, creating it if it doesn't exist yet.
 * is_manual=true means the worker never fetches for it. One per user.
 */
export async function getOrCreateManualProfile(): Promise<string> {
  const { supabase, user } = await authedClient();

  // Check for existing manual profile first
  const { data: existing } = await supabase
    .from("search_profiles")
    .select("id")
    .eq("user_id", user.id)
    .eq("is_manual", true)
    .maybeSingle();

  if (existing) return existing.id;

  // Create it — is_active=false + no schedule_cron = inherently excluded from
  // the worker scheduler even without the is_manual check.
  const { data: created, error } = await supabase
    .from("search_profiles")
    .insert({
      user_id:          user.id,
      name:             "Saved Jobs",
      keywords:         [],
      location:         "",
      is_active:        false,
      is_manual:        true,
      schedule_cron:    "",
      target_verticals: ["general", "tech", "healthcare"],
      visa_filter_mode: "probability_sort",
      working_rights:   "any",
    })
    .select("id")
    .single();

  if (error || !created) throw new Error(error?.message ?? "Failed to create Saved Jobs profile");
  revalidatePath("/profiles");
  return created.id;
}

export async function createProfile(formData: FormData) {
  const { supabase, user } = await authedClient();

  // Billing gate: read-only accounts and profile-cap-reached users are bounced
  // to billing. The profile form also pre-checks, so this is the hard backstop.
  const gate = await assertCanCreateProfile(user.id);
  if (!gate.allowed) {
    redirect(`/billing?denied=${gate.reason ?? "profile_cap"}`);
  }

  const keywords = (formData.get("keywords") as string)
    .split(",").map((k) => k.trim()).filter(Boolean);

  const runMode = formData.get("run_mode");
  // auto_days drives the cron day-of-month interval. Parse + clamp to a bounded
  // integer so a hand-edited form value can't inject arbitrary cron syntax into
  // schedule_cron (stored in the DB and registered with BullMQ by the worker).
  const autoDaysParsed = parseInt(String(formData.get("auto_days") ?? ""), 10);
  const autoDays = Number.isFinite(autoDaysParsed)
    ? Math.min(30, Math.max(1, autoDaysParsed))
    : 2;

  const scheduleCron = runMode === "auto" ? `0 21 */${autoDays} * *` : "0 21 */2 * *";
  const isActive = runMode === "auto";

  const { error } = await supabase.from("search_profiles").insert({
    user_id: user.id,
    name: formData.get("name") as string,
    keywords,
    location: (formData.get("location") as string) ?? "",
    visa_filter_mode: (formData.get("visa_filter_mode") as string) ?? "probability_sort",
    working_rights: (formData.get("working_rights") as string) ?? "any",
    schedule_cron: scheduleCron,
    is_active: isActive,
    // Role vertical is no longer set per search profile — it's the user's one
    // global choice in My CV (contact_details.role_families). Left empty here;
    // the analysis routes read it from My CV.
    target_verticals: [],
    home_address: ((formData.get("home_address") as string) ?? "").trim() || null,
    // home_lat/home_lng intentionally left null — the worker geocodes on the
    // next run via Nominatim.
    ...extractAdzunaFields(formData),
    ...extractAutomationFields(formData),
    ...extractSourceFields(formData),
    ...extractSettingFilter(formData),
  });

  if (error) throw new Error(error.message);
  triggerScheduleSync();
  revalidateTag(`profiles-${user.id}`, "default");
  revalidatePath("/dashboard");
  revalidatePath("/profiles");

  // Guided setup: creating a profile IS the searchProfile step (no run
  // required). If that was the last required step outstanding, jump straight
  // to the finished checklist — computed HERE, server-side, so the redirect
  // targets /instructions directly instead of /profiles?justCompleted=1 +a
  // client-side effect that re-checks and redirects again. That two-hop path
  // rendered a full /profiles page (list of every other search) for one
  // visible frame before bouncing away — this skips it entirely.
  const setupActive = formData.get("setup") === "1";
  const step = (formData.get("step") as string | null) ?? "";
  if (setupActive) {
    const [ent, { data: profileRows }] = await Promise.all([
      getEntitlement(user.id),
      supabase.from("search_profiles").select("id"),
    ]);
    const ids = ((profileRows ?? []) as Array<{ id: string }>).map((p) => p.id);
    const status = await getSetupStatus(user.id, ids, ent.status !== "none");
    if (isSetupComplete(status)) {
      redirect("/instructions?tab=setup");
    }
    redirect(`/profiles?setup=1&step=${step}&justCompleted=1`);
  }
  redirect("/profiles");
}

export async function updateProfile(profileId: string, formData: FormData) {
  const { supabase, user } = await authedClient();

  const keywords = (formData.get("keywords") as string)
    .split(",").map((k) => k.trim()).filter(Boolean);

  const runMode = formData.get("run_mode");
  // auto_days drives the cron day-of-month interval. Parse + clamp to a bounded
  // integer so a hand-edited form value can't inject arbitrary cron syntax into
  // schedule_cron (stored in the DB and registered with BullMQ by the worker).
  const autoDaysParsed = parseInt(String(formData.get("auto_days") ?? ""), 10);
  const autoDays = Number.isFinite(autoDaysParsed)
    ? Math.min(30, Math.max(1, autoDaysParsed))
    : 2;

  const scheduleCron = runMode === "auto" ? `0 21 */${autoDays} * *` : "0 21 */2 * *";
  const isActive = runMode === "auto";

  // Detect home_address change so we can invalidate the cached lat/lng and let
  // the worker re-geocode on the next run.
  const newHome = ((formData.get("home_address") as string) ?? "").trim() || null;
  const { data: prev } = await supabase
    .from("search_profiles")
    .select("home_address")
    .eq("id", profileId)
    .eq("user_id", user.id)
    .maybeSingle();
  const homeChanged = (prev?.home_address ?? null) !== newHome;

  const { error } = await supabase
    .from("search_profiles")
    .update({
      name: formData.get("name") as string,
      keywords,
      location: (formData.get("location") as string) ?? "",
      visa_filter_mode: (formData.get("visa_filter_mode") as string) ?? "probability_sort",
      working_rights: (formData.get("working_rights") as string) ?? "any",
      schedule_cron: scheduleCron,
      is_active: isActive,
      // Role vertical lives in My CV now (see createProfile) — intentionally not
      // written here, so any legacy per-profile value is left untouched.
      home_address: newHome,
      ...(homeChanged ? { home_lat: null, home_lng: null } : {}),
      ...extractAdzunaFields(formData),
      ...extractAutomationFields(formData),
      ...extractSourceFields(formData),
      ...extractSettingFilter(formData),
    })
    .eq("id", profileId)
    .eq("user_id", user.id);

  if (error) throw new Error(error.message);

  // If the user manually re-activated a paused profile, clear its pause row
  // so the resume banner (Deliverable 7) can't show a profile they already
  // resumed themselves through this form. profile_pause_state has no user
  // write policy (service-role only) — use the admin client for the delete.
  if (isActive) {
    const admin = createAdminClient();
    await admin.from("profile_pause_state").delete().eq("profile_id", profileId).eq("user_id", user.id);
  }

  triggerScheduleSync();
  revalidateTag(`profiles-${user.id}`, "default");
  revalidatePath("/dashboard");
  revalidatePath("/profiles");
  redirect("/profiles");
}

export async function copyProfile(profileId: string) {
  const { supabase, user } = await authedClient();

  // Copying creates a new profile — same billing gate as createProfile.
  const gate = await assertCanCreateProfile(user.id);
  if (!gate.allowed) {
    redirect(`/billing?denied=${gate.reason ?? "profile_cap"}`);
  }

  // Fetch original (verify ownership)
  const { data: orig } = await supabase
    .from("search_profiles")
    .select("*")
    .eq("id", profileId)
    .eq("user_id", user.id)
    .single();

  if (!orig) throw new Error("Profile not found");

  const targetName = `${orig.name} (copy)`;

  // Idempotency guard: a double-click / double-submit of "Duplicate" (the
  // button's disabled state only reflects after React re-renders, so two
  // clicks within the same tick can both reach here) previously created two
  // rows back-to-back. If we just created this exact copy moments ago,
  // redirect to it instead of inserting another — one click, one copy.
  const dedupeWindow = new Date(Date.now() - 10_000).toISOString();
  const { data: recentCopy } = await supabase
    .from("search_profiles")
    .select("id")
    .eq("user_id", user.id)
    .eq("name", targetName)
    .gte("created_at", dedupeWindow)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (recentCopy) {
    redirect(`/profiles/${recentCopy.id}/edit`);
  }

  const { data: newProfile, error } = await supabase
    .from("search_profiles")
    .insert({
      user_id: user.id,
      name: targetName,
      keywords: orig.keywords,
      location: orig.location,
      visa_filter_mode: orig.visa_filter_mode,
      working_rights: orig.working_rights,
      schedule_cron: orig.schedule_cron,
      is_active: false,   // copies start paused — user confirms before enabling
      target_verticals: orig.target_verticals,
      adzuna_title_keywords: orig.adzuna_title_keywords,
      adzuna_exclude_keywords: orig.adzuna_exclude_keywords,
      adzuna_salary_min: orig.adzuna_salary_min,
      adzuna_salary_max: orig.adzuna_salary_max,
      adzuna_contract_type: orig.adzuna_contract_type,
      adzuna_hours: orig.adzuna_hours,
      adzuna_distance_km: orig.adzuna_distance_km,
      adzuna_max_days_old: orig.adzuna_max_days_old,
      exclude_title_keywords: orig.exclude_title_keywords,
      must_include_phrases: orig.must_include_phrases,
      enabled_sources: orig.enabled_sources,
      seek_method: orig.seek_method,
      adzuna_method: orig.adzuna_method,
      home_address: orig.home_address,
      home_lat: orig.home_lat,
      home_lng: orig.home_lng,
    })
    .select("id")
    .single();

  if (error) throw new Error(error.message);
  revalidateTag(`profiles-${user.id}`, "default");
  revalidatePath("/dashboard");
  redirect(`/profiles/${newProfile.id}/edit`);
}

export async function deleteProfile(profileId: string) {
  const { supabase, user } = await authedClient();
  await supabase
    .from("search_profiles")
    .delete()
    .eq("id", profileId)
    .eq("user_id", user.id);
  triggerScheduleSync();
  revalidateTag(`profiles-${user.id}`, "default");
  revalidatePath("/dashboard");
  revalidatePath("/profiles");
  redirect("/profiles");
}


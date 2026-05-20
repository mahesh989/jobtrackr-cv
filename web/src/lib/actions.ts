"use server";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { Queue } from "bullmq";
import { Redis } from "ioredis";

const QUEUE_NAME = "jobtrackr-pipeline";

function triggerScheduleSync(): void {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return;
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue(QUEUE_NAME, { connection });
  queue
    .add("sync_schedules", { type: "sync_schedules" })
    .finally(() => queue.close())
    .catch((err) => console.error("[actions] sync_schedules enqueue failed:", err));
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function authedClient() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");
  return { supabase, user };
}

function extractAdzunaFields(formData: FormData) {
  const adzuna_contract_type = formData.get("adzuna_contract_type") as string;
  const adzuna_hours = formData.get("adzuna_hours") as string;
  const max_days = formData.get("adzuna_max_days_old") as string;
  const rawExcludeTitles = formData.get("exclude_title_keywords") as string;

  return {
    adzuna_title_keywords: (formData.get("adzuna_title_keywords") as string) || "",
    adzuna_exclude_keywords: (formData.get("adzuna_exclude_keywords") as string) || "",
    adzuna_salary_min: formData.get("adzuna_salary_min") ? parseInt(formData.get("adzuna_salary_min") as string, 10) : null,
    adzuna_salary_max: formData.get("adzuna_salary_max") ? parseInt(formData.get("adzuna_salary_max") as string, 10) : null,
    adzuna_contract_type: adzuna_contract_type === "any" || !adzuna_contract_type ? null : adzuna_contract_type,
    adzuna_hours: adzuna_hours === "any" || !adzuna_hours ? null : adzuna_hours,
    adzuna_distance_km: formData.get("adzuna_distance_km") ? parseInt(formData.get("adzuna_distance_km") as string, 10) : 25,
    adzuna_max_days_old: max_days === "any" ? null : (max_days ? parseInt(max_days, 10) : 14),
    exclude_title_keywords: rawExcludeTitles ? rawExcludeTitles.split(",").map(k => k.trim()).filter(Boolean) : [],
  };
}

// ── profile actions ───────────────────────────────────────────────────────────

export async function createProfile(formData: FormData) {
  const { supabase, user } = await authedClient();

  const keywords = (formData.get("keywords") as string)
    .split(",").map((k) => k.trim()).filter(Boolean);

  const runMode = formData.get("run_mode");
  const autoDays = formData.get("auto_days");
  
  let scheduleCron = "0 21 */2 * *"; 
  if (runMode === "auto" && autoDays) {
    scheduleCron = `0 21 */${autoDays} * *`;
  }
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
    target_verticals: formData.getAll("target_verticals") as string[],
    ...extractAdzunaFields(formData),
  });

  if (error) throw new Error(error.message);
  triggerScheduleSync();
  revalidatePath("/dashboard");
  redirect("/dashboard");
}

export async function updateProfile(profileId: string, formData: FormData) {
  const { supabase, user } = await authedClient();

  const keywords = (formData.get("keywords") as string)
    .split(",").map((k) => k.trim()).filter(Boolean);

  const runMode = formData.get("run_mode");
  const autoDays = formData.get("auto_days");
  
  let scheduleCron = "0 21 */2 * *"; 
  if (runMode === "auto" && autoDays) {
    scheduleCron = `0 21 */${autoDays} * *`;
  }
  const isActive = runMode === "auto";

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
      target_verticals: formData.getAll("target_verticals") as string[],
      ...extractAdzunaFields(formData),
    })
    .eq("id", profileId)
    .eq("user_id", user.id);

  if (error) throw new Error(error.message);
  triggerScheduleSync();
  revalidatePath("/dashboard");
  redirect("/dashboard");
}

export async function copyProfile(profileId: string) {
  const { supabase, user } = await authedClient();

  // Fetch original (verify ownership)
  const { data: orig } = await supabase
    .from("search_profiles")
    .select("*")
    .eq("id", profileId)
    .eq("user_id", user.id)
    .single();

  if (!orig) throw new Error("Profile not found");

  const { data: newProfile, error } = await supabase
    .from("search_profiles")
    .insert({
      user_id: user.id,
      name: `${orig.name} (copy)`,
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
    })
    .select("id")
    .single();

  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
  redirect(`/dashboard/profiles/${newProfile.id}/edit`);
}

export async function deleteProfile(profileId: string) {
  const { supabase, user } = await authedClient();
  await supabase
    .from("search_profiles")
    .delete()
    .eq("id", profileId)
    .eq("user_id", user.id);
  triggerScheduleSync();
  revalidatePath("/dashboard");
  redirect("/dashboard");
}

export async function toggleProfileActive(profileId: string, newActive: boolean) {
  const { supabase, user } = await authedClient();
  const { error } = await supabase
    .from("search_profiles")
    .update({ is_active: newActive })
    .eq("id", profileId)
    .eq("user_id", user.id);
  if (error) throw new Error(error.message);
  triggerScheduleSync();
  revalidatePath("/dashboard");
}

export async function cancelRun(runId: string, profileId: string) {
  const { supabase, user } = await authedClient();
  const { data: profile } = await supabase.from("search_profiles").select("id").eq("id", profileId).eq("user_id", user.id).single();
  if (!profile) return;

  // run_logs RLS exposes select/insert to the owning user but no UPDATE policy,
  // so the user-scoped client silently matches 0 rows. Use the admin client —
  // same pattern as the DELETE handler in /api/profiles/[id]/runs/route.ts.
  const admin = createAdminClient();
  await admin
    .from("run_logs")
    .update({
      status:        "failed",
      finished_at:   new Date().toISOString(),
      error_message: "Cancelled by user",
    })
    .eq("id", runId)
    .eq("status", "running");

  revalidatePath(`/dashboard/profiles/${profileId}/runs`);
  revalidatePath(`/dashboard/profiles/${profileId}/jobs`);
}

// ── job actions ───────────────────────────────────────────────────────────────

export async function markJobApplied(jobId: string, profileId: string) {
  const { supabase } = await authedClient();
  const { error, data } = await supabase
    .from("jobs")
    .update({ applied_at: new Date().toISOString(), seen_at: new Date().toISOString() })
    .eq("id", jobId)
    .select();

  if (error) throw new Error(error.message);
  if (!data || data.length === 0) throw new Error(`Failed to update job ${jobId} — RLS or ID mismatch`);

  revalidatePath(`/dashboard/profiles/${profileId}/jobs`);
}

export async function markJobDismissed(jobId: string, profileId: string) {
  const { supabase } = await authedClient();
  const { error, data } = await supabase
    .from("jobs")
    .update({ dismissed_at: new Date().toISOString() })
    .eq("id", jobId)
    .select();

  if (error) throw new Error(error.message);
  if (!data || data.length === 0) throw new Error(`Failed to dismiss job ${jobId} — RLS or ID mismatch`);

  revalidatePath(`/dashboard/profiles/${profileId}/jobs`);
}

export async function markJobSeen(jobId: string) {
  const { supabase } = await authedClient();
  await supabase
    .from("jobs")
    .update({ seen_at: new Date().toISOString() })
    .eq("id", jobId)
    .is("seen_at", null);
}

export async function getSavedJobsForRun(profileId: string, startedAt: string, finishedAt: string | null) {
  const { supabase, user } = await authedClient();
  const { data: profile } = await supabase.from("search_profiles").select("id").eq("id", profileId).eq("user_id", user.id).single();
  if (!profile) return [];

  let query = supabase
    .from("jobs")
    .select("url, title, company, location, keywords_matched, visa_likelihood, sponsorship_status, citizen_pr_only")
    .eq("profile_id", profileId)
    .gte("created_at", startedAt);
    
  if (finishedAt) {
    query = query.lte("created_at", finishedAt);
  }
  
  query = query.order("created_at", { ascending: false, nullsFirst: false });
  
  const { data } = await query;
  return data || [];
}

// ── admin actions ─────────────────────────────────────────────────────────────

async function requireAdminRole() {
  const { supabase, user } = await authedClient();
  const { data } = await supabase.from("users").select("role").eq("id", user.id).single();
  if (!data || !["founder", "admin"].includes(data.role)) {
    throw new Error("Forbidden");
  }
  return user;
}

export async function generateInviteCode() {
  const user = await requireAdminRole();
  const adminClient = createAdminClient();
  const code = "JT" + crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
  const { error } = await adminClient.from("invite_codes").insert({ code, created_by: user.id });
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard/admin");
}

export async function revokeInviteCode(code: string) {
  await requireAdminRole();
  const adminClient = createAdminClient();
  await adminClient
    .from("invite_codes")
    .update({ is_active: false })
    .eq("code", code)
    .is("used_by", null); // only revoke unused codes
  revalidatePath("/dashboard/admin");
}

export async function markProfileJobsSeen(profileId: string) {
  const { supabase, user } = await authedClient();
  // Verify profile ownership before bulk-marking
  const { data: profile } = await supabase
    .from("search_profiles")
    .select("id")
    .eq("id", profileId)
    .eq("user_id", user.id)
    .single();
  if (!profile) return;

  await supabase
    .from("jobs")
    .update({ seen_at: new Date().toISOString() })
    .eq("profile_id", profileId)
    .is("seen_at", null)
    .eq("is_expired", false)
    .is("dismissed_at", null);

  revalidatePath("/dashboard");
}

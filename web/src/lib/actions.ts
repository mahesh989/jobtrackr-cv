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

/**
 * Pipeline-automation fields (Phase A schema). Defaults match the
 * Migration 031 column defaults so first-time creation and a no-op
 * edit both land on the same values. Toggling automation_enabled off
 * is silent — the gate thresholds and email mode persist but aren't
 * acted on by the orchestrator until automation_enabled is true.
 */
function extractAutomationFields(formData: FormData) {
  const autoSend = (formData.get("auto_send_emails") as string) || "never";
  const allowedSend = new Set(["never", "after_review", "auto"]);

  // Numbers: parse + clamp into the CHECK-constraint ranges so a
  // hand-edited form value can't reach Postgres with a bad number.
  function clampInt(raw: FormDataEntryValue | null, fallback: number, min: number, max: number) {
    if (raw == null) return fallback;
    const n = parseInt(raw as string, 10);
    if (Number.isNaN(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  // min_initial_ats / min_final_ats are no longer per-profile (migration 041);
  // global constants in lib/atsThresholds. Do not include them in writes.
  return {
    automation_enabled:      formData.get("automation_enabled") === "on",
    role_match_strict:       formData.get("role_match_strict") === "on",
    auto_send_emails:        allowedSend.has(autoSend) ? autoSend : "never",
    daily_application_limit: clampInt(formData.get("daily_application_limit"), 10, 0, 1000),
  };
}

function extractAdzunaFields(formData: FormData) {
  const adzuna_contract_type = formData.get("adzuna_contract_type") as string;
  const adzuna_hours = formData.get("adzuna_hours") as string;
  const max_days = formData.get("adzuna_max_days_old") as string;
  const rawExcludeTitles = formData.get("exclude_title_keywords") as string;
  const rawMustInclude = formData.get("must_include_phrases") as string;

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
    must_include_phrases: rawMustInclude ? rawMustInclude.split(",").map(k => k.trim()).filter(Boolean) : [],
  };
}

/**
 * Per-profile source selection (Migration 041). enabled_sources holds the
 * adapter names the user ticked; null = all active sources. seek_method picks
 * the free direct scrape vs the paid Apify actor.
 */
function extractSourceFields(formData: FormData) {
  const selected = formData.getAll("enabled_sources").map(String).filter(Boolean);
  const seekMethod = formData.get("seek_method") === "actor" ? "actor" : "direct";
  return {
    enabled_sources: selected.length > 0 ? selected : null,
    seek_method:     seekMethod,
  };
}

// ── profile actions ───────────────────────────────────────────────────────────

export async function createProfile(formData: FormData) {
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
    ...extractAutomationFields(formData),
    ...extractSourceFields(formData),
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
  // auto_days drives the cron day-of-month interval. Parse + clamp to a bounded
  // integer so a hand-edited form value can't inject arbitrary cron syntax into
  // schedule_cron (stored in the DB and registered with BullMQ by the worker).
  const autoDaysParsed = parseInt(String(formData.get("auto_days") ?? ""), 10);
  const autoDays = Number.isFinite(autoDaysParsed)
    ? Math.min(30, Math.max(1, autoDaysParsed))
    : 2;

  const scheduleCron = runMode === "auto" ? `0 21 */${autoDays} * *` : "0 21 */2 * *";
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
      ...extractAutomationFields(formData),
      ...extractSourceFields(formData),
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
      must_include_phrases: orig.must_include_phrases,
      enabled_sources: orig.enabled_sources,
      seek_method: orig.seek_method,
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
  revalidatePath("/dashboard"); // dashboard hosts a unified jobs board too
  revalidatePath("/dashboard/applications"); // outbox bucket may change
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
  revalidatePath("/dashboard");
  revalidatePath("/dashboard/applications");
}

/**
 * Pool decision — user chose how to apply for this job.
 * email provided → Ready to email tab (contact_email + has_email set)
 * no email       → Ready to apply tab (manual apply)
 */
export async function markPoolDecision(jobId: string, profileId: string, email?: string) {
  const { supabase } = await authedClient();
  // Note: jobs.has_email is a GENERATED column (contact_email IS NOT NULL).
  // We must NOT write to it directly — Postgres rejects writes to GENERATED ALWAYS.
  // Setting contact_email below automatically updates has_email via the generation expression.
  const patch: Record<string, unknown> = {
    pool_decision_at: new Date().toISOString(),
  };
  if (email && email.trim()) {
    patch.contact_email = email.trim();
  }
  const { error, data } = await supabase
    .from("jobs")
    .update(patch)
    .eq("id", jobId)
    .select();

  if (error) throw new Error(error.message);
  if (!data || data.length === 0) throw new Error(`Failed to update job ${jobId} — RLS or ID mismatch`);

  revalidatePath(`/dashboard/profiles/${profileId}/jobs`);
  revalidatePath("/dashboard/applications");
}

/**
 * Bulk variants of the pool actions. RLS still scopes each update to jobs
 * the user owns (via the profile → user_id chain) — sending extra ids in
 * the array is safe, those rows just won't match.
 */

export async function bulkMarkPoolNoEmail(jobIds: string[]) {
  if (jobIds.length === 0) return { updated: 0 };
  const { supabase } = await authedClient();
  // pool_decision_at stamped, contact_email left null → routes to "Ready to apply".
  const { data, error } = await supabase
    .from("jobs")
    .update({ pool_decision_at: new Date().toISOString() })
    .in("id", jobIds)
    .is("pool_decision_at", null)   // only flip undecided rows
    .select("id");

  if (error) throw new Error(error.message);
  revalidatePath("/dashboard/applications");
  // Per-profile boards may also surface these jobs — broad revalidate is fine.
  revalidatePath("/dashboard");
  return { updated: data?.length ?? 0 };
}

export async function bulkArchiveJobs(jobIds: string[]) {
  if (jobIds.length === 0) return { updated: 0 };
  const { supabase } = await authedClient();
  const { data, error } = await supabase
    .from("jobs")
    .update({ dismissed_at: new Date().toISOString() })
    .in("id", jobIds)
    .is("dismissed_at", null)       // don't re-stamp already-dismissed
    .is("applied_at", null)         // don't archive jobs already applied
    .select("id");

  if (error) throw new Error(error.message);
  revalidatePath("/dashboard/applications");
  revalidatePath("/dashboard");
  return { updated: data?.length ?? 0 };
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

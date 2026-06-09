"use server";

import { createHash, randomUUID } from "crypto";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { assertCanCreateProfile } from "@/lib/billing/entitlements";

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

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
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
  // Adzuna defaults to 'api' (fast). 'direct' is opt-in for full JDs.
  const adzunaMethod = formData.get("adzuna_method") === "direct" ? "direct" : "api";
  return {
    enabled_sources: selected.length > 0 ? selected : null,
    seek_method:     seekMethod,
    adzuna_method:   adzunaMethod,
  };
}

// ── manual / saved-jobs profile ──────────────────────────────────────────────

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
  revalidatePath("/dashboard/profiles");
  return created.id;
}

/**
 * Add a manually-found job to the user's Saved Jobs profile.
 * Deduplicates by source_url (case-insensitive) — paste the same URL twice
 * and you get the existing job back.
 */
export async function addManualJob(input: {
  title:        string;
  company:      string | null;
  location:     string | null;
  description:  string;      // the full JD text the user pasted / scraped
  source_url:   string | null;
}): Promise<{ jobId: string; alreadyExisted: boolean }> {
  const { supabase, user } = await authedClient();

  const profileId = await getOrCreateManualProfile();

  // Dedupe by URL when we have one
  if (input.source_url) {
    const { data: dupe } = await supabase
      .from("jobs")
      .select("id")
      .eq("profile_id", profileId)
      .ilike("url", input.source_url.trim())
      .maybeSingle();
    if (dupe) return { jobId: dupe.id, alreadyExisted: true };
  }

  const jdLen = input.description?.trim().length ?? 0;

  // jobs.url_hash is NOT NULL + unique per (profile_id, url_hash). Worker uses
  // sha256(url); paste-only entries get a synthetic manual:// UUID so each
  // save is distinct without a real posting URL.
  const url = input.source_url?.trim() || `manual://${randomUUID()}`;

  const { data: job, error } = await supabase
    .from("jobs")
    .insert({
      profile_id:    profileId,
      url,
      url_hash:      sha256(url),
      title:         input.title.trim(),
      company:       input.company?.trim() ?? "",
      location:      input.location?.trim() ?? "",
      description:   input.description.trim(),
      // Classify JD quality at insert time — same thresholds as the worker.
      jd_quality:    jdLen >= 1400 ? "rich" : jdLen >= 200 ? "thin" : "unknown",
      source:        "manual",
      source_tier:   4,
    })
    .select("id")
    .single();

  if (error || !job) throw new Error(error?.message ?? "Failed to add job");
  revalidatePath("/dashboard");
  revalidatePath(`/dashboard/profiles/${profileId}/jobs`);
  revalidatePath("/dashboard/profiles");
  return { jobId: job.id, alreadyExisted: false };
}

// ── profile actions ───────────────────────────────────────────────────────────

export async function createProfile(formData: FormData) {
  const { supabase, user } = await authedClient();

  // Billing gate: read-only accounts and profile-cap-reached users are bounced
  // to billing. The profile form also pre-checks, so this is the hard backstop.
  const gate = await assertCanCreateProfile(user.id);
  if (!gate.allowed) {
    redirect(`/dashboard/billing?denied=${gate.reason ?? "profile_cap"}`);
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
    target_verticals: formData.getAll("target_verticals") as string[],
    home_address: ((formData.get("home_address") as string) ?? "").trim() || null,
    // home_lat/home_lng intentionally left null — the worker geocodes on the
    // next run via Nominatim.
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
      target_verticals: formData.getAll("target_verticals") as string[],
      home_address: newHome,
      ...(homeChanged ? { home_lat: null, home_lng: null } : {}),
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

  // Copying creates a new profile — same billing gate as createProfile.
  const gate = await assertCanCreateProfile(user.id);
  if (!gate.allowed) {
    redirect(`/dashboard/billing?denied=${gate.reason ?? "profile_cap"}`);
  }

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
      adzuna_method: orig.adzuna_method,
      home_address: orig.home_address,
      home_lat: orig.home_lat,
      home_lng: orig.home_lng,
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
  revalidatePath("/dashboard/profiles");
  // Land back on the profiles list (where the delete was initiated), not the
  // dashboard — the user was managing profiles, so keep them in that context.
  redirect("/dashboard/profiles");
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

/**
 * Cancel a running analysis_run (individual job tailoring pipeline).
 * Marks the run as failed so cv-backend's orchestrator stops at its next
 * checkpoint and the Realtime subscription on the analysis page updates
 * instantly. Tokens for already-completed steps are already spent; this
 * stops any remaining steps (e.g. tailoring + cover-letter generation).
 */
export async function cancelAnalysisRun(runId: string) {
  const { supabase, user } = await authedClient();
  // Verify ownership via analysis_runs directly.
  const { data: existing } = await supabase
    .from("analysis_runs")
    .select("id, status")
    .eq("id", runId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!existing) return;
  if (existing.status !== "pending" && existing.status !== "running") return;

  const admin = createAdminClient();
  await admin
    .from("analysis_runs")
    .update({
      status:        "failed",
      error_message: "Cancelled by user",
      completed_at:  new Date().toISOString(),
    })
    .eq("id", runId);
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

/**
 * Undo an accidental "applied" mark. Clears applied_at so the job returns to
 * the Application pool tab. Safe to call if the user accidentally clicked
 * "Apply now" without actually applying on the job site.
 */
export async function markJobUnapplied(jobId: string, profileId: string) {
  const { supabase } = await authedClient();
  const { error, data } = await supabase
    .from("jobs")
    .update({ applied_at: null })
    .eq("id", jobId)
    .select();

  if (error) throw new Error(error.message);
  if (!data || data.length === 0) throw new Error(`Failed to update job ${jobId} — RLS or ID mismatch`);

  revalidatePath(`/dashboard/profiles/${profileId}/jobs`);
  revalidatePath("/dashboard");
  revalidatePath("/dashboard/applications");
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

/**
 * Toggle "starred" on a batch of jobs. Star is a personal-shortlist marker
 * (see migration 053). Stars unstarred rows; ignores already-starred ones.
 * Use bulkUnstarJobs() to clear.
 */
export async function bulkStarJobs(jobIds: string[]) {
  if (jobIds.length === 0) return { updated: 0 };
  const { supabase } = await authedClient();
  const { data, error } = await supabase
    .from("jobs")
    .update({ starred_at: new Date().toISOString() })
    .in("id", jobIds)
    .is("starred_at", null)   // don't re-stamp already-starred
    .select("id");

  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
  return { updated: data?.length ?? 0 };
}

/** Clear starred_at on a batch of jobs. */
export async function bulkUnstarJobs(jobIds: string[]) {
  if (jobIds.length === 0) return { updated: 0 };
  const { supabase } = await authedClient();
  const { data, error } = await supabase
    .from("jobs")
    .update({ starred_at: null })
    .in("id", jobIds)
    .not("starred_at", "is", null)
    .select("id");

  if (error) throw new Error(error.message);
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
    .select("id, profile_id");

  if (error) throw new Error(error.message);

  // Bust the cache for every per-profile board the archived jobs belong to
  // — without this, ProfileJobBoard would still serve cached rows including
  // the just-archived items (router.refresh on the client revalidates the
  // current route only, and the action ran on the server). Falling back to
  // a full /dashboard/profiles revalidation covers the dashboard sidebar
  // counts and the profile list view.
  const profileIds = Array.from(new Set(
    ((data ?? []) as Array<{ id: string; profile_id: string }>).map((r) => r.profile_id),
  ));
  for (const pid of profileIds) {
    revalidatePath(`/dashboard/profiles/${pid}/jobs`);
    revalidatePath(`/dashboard/profiles/${pid}/runs`);
  }
  revalidatePath("/dashboard/profiles");
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

/**
 * Stamp the user's "last viewed the Applications outbox" time to now. Drives
 * the sidebar Applications badge — after this fires, the badge counts only
 * cover letters that complete later, so the count clears on view and stays
 * cleared until something new lands. Fired client-side from the outbox page.
 */
export async function markApplicationsSeen() {
  const { supabase, user } = await authedClient();
  await supabase
    .from("users")
    .update({ applications_seen_at: new Date().toISOString() })
    .eq("id", user.id);
  revalidatePath("/dashboard", "layout");
}

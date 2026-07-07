"use server";

import { randomUUID } from "crypto";
import { revalidatePath } from "next/cache";
import { authedClient, sha256 } from "./_helpers";
import { getOrCreateManualProfile } from "./profiles";
import { classifySettingText } from "@/lib/settingClassifier";

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
  // Classify work setting at insert time (Migration 078) — manual jobs bypass
  // the worker/bucket, so hand-added JDs still get a setting_category (badge +
  // per-profile filter). Deterministic web port; non-care JDs stay null.
  const setting = classifySettingText(input.description.trim());

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
      // Classify JD quality at insert time — same threshold as the DB trigger
      // (migration 062) + the worker. The trigger re-stamps this on insert too.
      jd_quality:    jdLen >= 1000 ? "rich" : jdLen >= 200 ? "thin" : "unknown",
      setting_category:   setting.setting_category,
      setting_confidence: setting.setting_confidence,
      setting_evidence:   setting.setting_evidence,
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

  // No revalidatePath — the client already handles the optimistic removal
  // (card fades out via exitPhase animation in JobTable). Triggering a server
  // re-render here would show the loading skeleton despite the card being
  // gone from the UI, creating a jarring flash. Funnel counts update on the
  // next full navigation to the board (acceptable trade-off for instant feel).
  void profileId; // suppress unused-var lint
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
 * Toggle "starred" on a batch of jobs. Star is a personal-shortlist marker
 * (see migration 053). Stars unstarred rows; ignores already-starred ones.
 * Use bulkUnstarJobs() to clear.
 */
export async function toggleStarJob(jobId: string) {
  const { supabase } = await authedClient();
  const { data: row, error: fetchErr } = await supabase
    .from("jobs")
    .select("starred_at")
    .eq("id", jobId)
    .single();
  if (fetchErr) throw new Error(fetchErr.message);
  const newValue = row?.starred_at ? null : new Date().toISOString();
  const { error } = await supabase
    .from("jobs")
    .update({ starred_at: newValue })
    .eq("id", jobId);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
  return { starred: newValue != null };
}

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


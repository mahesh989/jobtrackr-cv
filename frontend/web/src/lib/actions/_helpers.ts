// Shared helpers for the server-action modules in this folder.
//
// This file is intentionally NOT a "use server" module: it exports synchronous
// helpers (FormData parsers, hashing), which a "use server" file is not allowed
// to export. The action modules (profiles.ts, jobs.ts, …) import from here.

import { createHash } from "crypto";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { Queue } from "bullmq";
import { Redis } from "ioredis";

const QUEUE_NAME = "jobtrackr-pipeline";

/**
 * Fire-and-forget: ask the worker to re-sync BullMQ repeatable jobs with the
 * current set of active profile cron schedules. Called after any profile
 * create/update/delete/toggle that can change scheduling.
 */
export function triggerScheduleSync(): void {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return;
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue(QUEUE_NAME, { connection });
  queue
    .add("sync_schedules", { type: "sync_schedules" })
    .finally(() => queue.close())
    .catch((err) => console.error("[actions] sync_schedules enqueue failed:", err));
}

/** Resolve the signed-in user, or redirect to login. Returns a scoped client. */
export async function authedClient() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");
  return { supabase, user };
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Pipeline-automation fields (Phase A schema). Defaults match the
 * Migration 031 column defaults so first-time creation and a no-op
 * edit both land on the same values. Toggling automation_enabled off
 * is silent — the gate thresholds and email mode persist but aren't
 * acted on by the orchestrator until automation_enabled is true.
 */
export function extractAutomationFields(formData: FormData) {
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

export function extractAdzunaFields(formData: FormData) {
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
 * Work-setting filter (Migration 078). Multi-checkbox of the 4 canonical
 * categories the user wants to keep; empty = no filtering (opt-in). Validated
 * against the allowed keys so a hand-edited form can't inject arbitrary values.
 */
const SETTING_CATEGORY_KEYS = new Set([
  "hospital_clinical",
  "residential_aged_care",
  "home_community",
  "other",
]);
export function extractSettingFilter(formData: FormData) {
  const selected = formData
    .getAll("setting_filter")
    .map(String)
    .filter((v) => SETTING_CATEGORY_KEYS.has(v));
  return { setting_filter: Array.from(new Set(selected)) };
}

/**
 * Per-profile source selection (Migration 041). enabled_sources holds the
 * adapter names the user ticked; null = all active sources. seek_method picks
 * the free direct scrape vs the paid Apify actor.
 */
export function extractSourceFields(formData: FormData) {
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

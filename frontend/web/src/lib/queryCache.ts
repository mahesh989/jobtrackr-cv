/**
 * unstable_cache wrappers for stable, user-specific data.
 *
 * "Stable" = changes only on an explicit user action (save profile, upload CV,
 * save preferences) — not on every page load. Caching these for 30–60 s means
 * the second visit to any page within a session hits Next.js's Data Cache
 * instead of Supabase, saving 80–150 ms per query.
 *
 * Cache keys are scoped by userId so different users never share data.
 * Each wrapper also carries a revalidation tag — call revalidateTag(tag)
 * from the relevant mutation action to bust the cache immediately on write.
 *
 * Tags:
 *   profiles-<userId>      — bust on createProfile / updateProfile / deleteProfile
 *   cv-versions-<userId>   — bust on CV upload / activate
 *   preferences-<userId>   — bust on preferences PATCH
 *
 * Important: use createAdminClient() here, NOT the SSR cookie-based client.
 * The cookie-based client is request-scoped and cannot be captured inside
 * unstable_cache (the cached function must be serialisable between invocations).
 * The admin client is stateless (service-role key from env), so it's safe.
 * Row-level access is enforced by the userId parameter used as both the DB
 * filter and the cache key.
 */

import { unstable_cache } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";

// ── Profiles ────────────────────────────────────────────────────────────────

export type CachedProfile = {
  id: string;
  name: string;
  is_active: boolean;
  is_manual: boolean | null;
  keywords: string[] | null;
  location: string | null;
  schedule_cron: string | null;
  target_verticals: string[] | null;
  home_address: string | null;
  home_lat: number | null;
  home_lng: number | null;
  adzuna_exclude_keywords: string | null;
  created_at: string;
};

/**
 * All search_profiles for a user, newest-first.
 * Cached 30 s. Busted by revalidateTag(`profiles-${userId}`).
 */
export function getCachedProfiles(userId: string): Promise<CachedProfile[]> {
  return unstable_cache(
    async () => {
      const admin = createAdminClient();
      const { data } = await admin
        .from("search_profiles")
        .select("id, name, is_active, is_manual, keywords, location, schedule_cron, target_verticals, home_address, home_lat, home_lng, adzuna_exclude_keywords, created_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false });
      return (data ?? []) as CachedProfile[];
    },
    [`profiles`, userId],
    { revalidate: 30, tags: [`profiles-${userId}`] },
  )();
}

// ── CV versions ─────────────────────────────────────────────────────────────

type CachedCvVersion = {
  id: string;
  label: string | null;
  cv_text: string;
  categorised_skills: unknown;
  is_active: boolean;
  created_at: string;
};

/**
 * The user's active CV version.
 * Cached 60 s. Busted by revalidateTag(`cv-versions-${userId}`).
 */
function getCachedActiveCv(userId: string): Promise<CachedCvVersion | null> {
  return unstable_cache(
    async () => {
      const admin = createAdminClient();
      const { data } = await admin
        .from("cv_versions")
        .select("id, label, cv_text, categorised_skills, is_active, created_at")
        .eq("user_id", userId)
        .eq("is_active", true)
        .maybeSingle();
      return (data as CachedCvVersion | null) ?? null;
    },
    [`active-cv`, userId],
    { revalidate: 60, tags: [`cv-versions-${userId}`] },
  )();
}

// ── User preferences ─────────────────────────────────────────────────────────

type CachedPreferences = {
  contact_details: Record<string, unknown> | null;
};

/**
 * The user's saved contact details / preferences.
 * Cached 60 s. Busted by revalidateTag(`preferences-${userId}`).
 */
function getCachedPreferences(userId: string): Promise<CachedPreferences | null> {
  return unstable_cache(
    async () => {
      const admin = createAdminClient();
      const { data } = await admin
        .from("user_preferences")
        .select("contact_details")
        .eq("user_id", userId)
        .maybeSingle();
      return (data as CachedPreferences | null) ?? null;
    },
    [`preferences`, userId],
    { revalidate: 60, tags: [`preferences-${userId}`] },
  )();
}

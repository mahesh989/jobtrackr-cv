/**
 * Auth guards — the module's public helpers for "who is the caller?".
 *
 * getAuthUser  — cached per-render lookup for Server Components (RSC).
 */

import { cache } from "react";
import { createClient } from "@/lib/supabase/server";

/**
 * Cached auth helper — deduplicates supabase.auth.getUser() within a single
 * RSC render tree.
 *
 * Problem: the dashboard layout calls getUser(), then every page component
 * also calls getUser() to do its own auth check. Without caching that is
 * 2 network round-trips to the Supabase Auth API for every page load.
 *
 * React.cache() memoises the result for the duration of one server render.
 * It resets per request (safe — no cross-user leakage).
 */
export const getAuthUser = cache(async () => {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user;
});

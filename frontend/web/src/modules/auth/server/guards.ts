/**
 * Auth guards — the module's public helpers for "who is the caller?".
 *
 * getAuthUser  — cached per-render lookup for Server Components (RSC).
 * requireUser  — API-route guard: returns the user + client, or a ready-made
 *                401 response. Replaces the hand-rolled 3-line check
 *                duplicated across API routes; adopt incrementally:
 *
 *                  const auth = await requireUser();
 *                  if (!auth.user) return auth.response;
 *                  // auth.user / auth.supabase from here on
 */

import { cache } from "react";
import { NextResponse } from "next/server";
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

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

export async function requireUser(): Promise<
  | { user: NonNullable<Awaited<ReturnType<typeof getAuthUser>>>; supabase: SupabaseServerClient; response: null }
  | { user: null; supabase: SupabaseServerClient; response: NextResponse }
> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return {
      user: null,
      supabase,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }
  return { user, supabase, response: null };
}

/**
 * Server-side admin guard utilities.
 *
 * Usage (in any admin page.tsx):
 *   const { user, admin } = await requireAdmin();
 *
 * Redirects to / if the user is not founder/admin.
 * Returns both the auth user and a pre-constructed admin Supabase client
 * so pages don't need to reconstruct both.
 */
import { createClient }      from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ADMIN_ROLES }       from "@/lib/constants";
import { redirect }          from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { formatDateTime }    from "@/lib/dates";

export async function requireAdmin(): Promise<{
  userId: string;
  email:  string;
  role:   string;
  admin:  SupabaseClient;
}> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const admin = createAdminClient();
  const { data: me } = await admin
    .from("users").select("role").eq("id", user.id).single();

  if (!me || !(ADMIN_ROLES as readonly string[]).includes(me.role as string)) redirect("/dashboard");

  return { userId: user.id, email: user.email!, role: me.role as string, admin };
}

/** ISO date → "12 Jun 2026, 14:32" */
export const fmtDateTime = formatDateTime;

// ── Time-range helpers (used by admin pages with ?range= param) ──────────────

export type RangeKey = "7d" | "30d" | "90d" | "all";

export function resolveRange(raw: string | undefined): RangeKey {
  if (raw === "7d" || raw === "90d" || raw === "all") return raw;
  return "30d";
}

/** Returns the earliest Date for the given range (Date(0) = "all time"). */
export function rangeStart(range: RangeKey): Date {
  const now = new Date();
  if (range === "7d")  return new Date(now.getTime() - 7  * 86400_000);
  if (range === "30d") return new Date(now.getTime() - 30 * 86400_000);
  if (range === "90d") return new Date(now.getTime() - 90 * 86400_000);
  return new Date(0);
}

export const RANGE_LABELS: Record<RangeKey, string> = {
  "7d":  "7 days",
  "30d": "30 days",
  "90d": "90 days",
  "all": "All time",
};

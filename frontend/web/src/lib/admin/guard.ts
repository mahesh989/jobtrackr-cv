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
import { formatDateTime }    from "@/lib/date";

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

/** Format millicents (USD cents × 1000) → "$0.0042" */
export function formatCost(millicents: number): string {
  const dollars = millicents / 100_000;
  if (dollars === 0) return "$0";
  if (dollars < 0.001) return `$${dollars.toFixed(6)}`;
  if (dollars < 0.10)  return `$${dollars.toFixed(4)}`;
  if (dollars < 10)    return `$${dollars.toFixed(3)}`;
  return `$${dollars.toFixed(2)}`;
}

/** Format token count → "1.2M", "45k", "892" */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Format latency ms → "1.2s", "842ms" */
export function formatLatency(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

/** ISO date → "12 Jun" */
function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "short" });
}

/** ISO date → "12 Jun 2026, 14:32" */
export const fmtDateTime = formatDateTime;

/** Relative time → "2 mins ago", "3 days ago" */
export function timeAgo(iso: string): string {
  const secs = (Date.now() - new Date(iso).getTime()) / 1000;
  if (secs < 60)          return "just now";
  if (secs < 3600)        return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400)       return `${Math.floor(secs / 3600)}h ago`;
  if (secs < 86400 * 7)   return `${Math.floor(secs / 86400)}d ago`;
  return fmtDate(iso);
}

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

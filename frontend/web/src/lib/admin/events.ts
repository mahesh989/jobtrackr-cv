/**
 * User event emitter — server-side only.
 *
 * Writes one row to user_events for each key user action.
 * Fire-and-forget: errors are logged but never thrown to callers.
 *
 * Call this from:
 *   - auth/confirm route (login event)
 *   - server actions (analysis_started, email_sent, etc.)
 *   - api routes (cover_letter_generated, etc.)
 *
 * The admin activity page reads from this table.
 */
import { createAdminClient } from "@/lib/supabase/admin";

export type EventType =
  | "login"
  | "logout"
  | "analysis_started"
  | "analysis_completed"
  | "analysis_failed"
  | "analysis_cancelled"
  | "cover_letter_generated"
  | "email_sent"
  | "cv_downloaded"
  | "zip_downloaded"
  | "profile_saved"
  | "email_connected"
  | "email_disconnected"
  | "plan_upgraded"
  | "trial_started"
  | "settings_saved";

interface EmitOptions {
  userId:    string;
  eventType: EventType;
  metadata?: Record<string, unknown>;
  ip?:       string;
  country?:  string;
  city?:     string;
  device?:   string;
}

/**
 * Emit a user_events row. Fire-and-forget — never throws.
 * Designed to be called without await in hot paths.
 */
export async function emitEvent(opts: EmitOptions): Promise<void> {
  try {
    const admin = createAdminClient();
    await admin.from("user_events").insert({
      user_id:    opts.userId,
      event_type: opts.eventType,
      metadata:   opts.metadata ?? {},
      ip:         opts.ip      ?? null,
      country:    opts.country ?? null,
      city:       opts.city    ?? null,
      device:     opts.device  ?? null,
    });
  } catch {
    // Silently swallow — observability must never break the product.
  }
}

/**
 * Parse a minimal device type from the User-Agent header.
 * Returns 'mobile' | 'tablet' | 'desktop' | null.
 */
export function parseDevice(ua: string | null): string | null {
  if (!ua) return null;
  const lower = ua.toLowerCase();
  if (/ipad|tablet|kindle|playbook/.test(lower)) return "tablet";
  if (/mobile|android|iphone|ipod|blackberry|windows phone/.test(lower)) return "mobile";
  return "desktop";
}

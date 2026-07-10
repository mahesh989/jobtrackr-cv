// New-jobs notification sweep — runs every 15 minutes (queue/scheduler.ts).
//
// Scheduled (auto) runs that save new jobs write one row per profile into
// pending_job_notifications (see orchestrator.ts stage 12 follow-up). This
// sweep drains that queue into ONE batched email per user per sweep window:
// a 5-minute settle window means a user with several profiles that all run
// within the same tick gets a single "X new jobs" email, not one per
// profile. Never runs for manual runs — those never write to this table.

import { db } from "../db/client.js";
import { resend } from "./resendClient.js";
import { sendNewJobsEmail, type NewJobsProfileGroup, type NewJobsFlavorItem } from "./engagementEmails.js";

const SETTLE_WINDOW_MINUTES = 5;
const STALE_CLAIM_MINUTES = 60;
const PURGE_AFTER_DAYS = 7;

interface PendingRow {
  id: string;
  user_id: string;
  profile_id: string;
  profile_name: string;
  jobs_saved: number;
  created_at: string;
}

/** Pure helper — groups settled rows by user_id. Exported for unit testing. */
export function groupByUser(rows: PendingRow[]): Map<string, PendingRow[]> {
  const byUser = new Map<string, PendingRow[]>();
  for (const row of rows) {
    if (!byUser.has(row.user_id)) byUser.set(row.user_id, []);
    byUser.get(row.user_id)!.push(row);
  }
  return byUser;
}

export async function runNotifySweep(): Promise<void> {
  if (!resend) {
    console.log("[notifySweep] RESEND_API_KEY not set — skipping");
    return;
  }

  const now = Date.now();
  const staleClaimBefore = new Date(now - STALE_CLAIM_MINUTES * 60_000).toISOString();
  const purgeBefore = new Date(now - PURGE_AFTER_DAYS * 24 * 60 * 60_000).toISOString();
  const settleBefore = new Date(now - SETTLE_WINDOW_MINUTES * 60_000).toISOString();

  // Unclaim stale claims — a sweep that claimed rows but crashed/failed
  // before sending must not leave them stuck forever.
  const { error: unclaimErr } = await db
    .from("pending_job_notifications")
    .update({ claimed_at: null })
    .is("sent_at", null)
    .lt("claimed_at", staleClaimBefore);
  if (unclaimErr) console.error("[notifySweep] unclaim-stale failed:", unclaimErr.message);

  // Purge old sent rows.
  const { error: purgeErr } = await db
    .from("pending_job_notifications")
    .delete()
    .lt("sent_at", purgeBefore);
  if (purgeErr) console.error("[notifySweep] purge failed:", purgeErr.message);

  // Load settled, unclaimed, unsent rows.
  const { data: rows, error: loadErr } = await db
    .from("pending_job_notifications")
    .select("id, user_id, profile_id, profile_name, jobs_saved, created_at")
    .is("sent_at", null)
    .is("claimed_at", null)
    .lt("created_at", settleBefore);

  if (loadErr) {
    console.error("[notifySweep] load failed:", loadErr.message);
    return;
  }
  if (!rows || rows.length === 0) {
    return;
  }

  const byUser = groupByUser(rows as PendingRow[]);
  let sent = 0;
  let skippedOptOut = 0;
  let skippedRace = 0;

  for (const [userId, userRows] of byUser) {
    const { data: engagement } = await db
      .from("user_engagement")
      .select("notify_new_jobs")
      .eq("user_id", userId)
      .maybeSingle();

    const notifyEnabled = (engagement?.notify_new_jobs as boolean | undefined) ?? true;

    if (!notifyEnabled) {
      // Mark sent without emailing so they don't pile up on every sweep.
      const ids = userRows.map((r) => r.id);
      await db
        .from("pending_job_notifications")
        .update({ sent_at: new Date().toISOString() })
        .in("id", ids);
      skippedOptOut++;
      continue;
    }

    // Claim this user's rows — race-safe: only rows still claimed_at IS NULL
    // are returned, so a concurrent sweep can't double-claim.
    const ids = userRows.map((r) => r.id);
    const { data: claimedRows, error: claimErr } = await db
      .from("pending_job_notifications")
      .update({ claimed_at: new Date().toISOString() })
      .in("id", ids)
      .is("claimed_at", null)
      .select("id, user_id, profile_id, profile_name, jobs_saved, created_at");

    if (claimErr) {
      console.error(`[notifySweep] claim failed for user ${userId}:`, claimErr.message);
      continue;
    }
    if (!claimedRows || claimedRows.length === 0) {
      skippedRace++;
      continue;
    }

    const { data: userRow } = await db.from("users").select("email").eq("id", userId).maybeSingle();
    const email = userRow?.email as string | undefined;
    if (!email) {
      console.warn(`[notifySweep] no email for user ${userId} — releasing claim`);
      await db
        .from("pending_job_notifications")
        .update({ claimed_at: null })
        .in("id", claimedRows.map((r) => r.id));
      continue;
    }

    const claimed = claimedRows as PendingRow[];
    const groups: NewJobsProfileGroup[] = Array.from(
      claimed
        .reduce<Map<string, NewJobsProfileGroup>>((acc, r) => {
          const existing = acc.get(r.profile_id);
          if (existing) {
            existing.jobsSaved += r.jobs_saved;
          } else {
            acc.set(r.profile_id, { profileName: r.profile_name || "Your search", jobsSaved: r.jobs_saved });
          }
          return acc;
        }, new Map())
        .values(),
    );

    const profileIds = Array.from(new Set(claimed.map((r) => r.profile_id)));
    let flavor: NewJobsFlavorItem[] = [];
    try {
      const { data: recentJobs } = await db
        .from("jobs")
        .select("title, company, created_at")
        .in("profile_id", profileIds)
        .order("created_at", { ascending: false })
        .limit(5);
      flavor = ((recentJobs ?? []) as { title: string; company: string }[]).map((j) => ({
        title: j.title,
        company: j.company,
      }));
    } catch (err) {
      // Flavor is cosmetic — fall back to a counts-only email rather than fail.
      console.warn(`[notifySweep] flavor query failed for user ${userId} — sending counts-only:`, err);
      flavor = [];
    }

    const ok = await sendNewJobsEmail(userId, email, groups, flavor);
    const idsToUpdate = claimed.map((r) => r.id);
    if (ok) {
      await db
        .from("pending_job_notifications")
        .update({ sent_at: new Date().toISOString() })
        .in("id", idsToUpdate);
      sent++;
    } else {
      // Send failed — release the claim so the next sweep retries.
      await db
        .from("pending_job_notifications")
        .update({ claimed_at: null })
        .in("id", idsToUpdate);
      console.error(`[notifySweep] send failed for user ${userId} — released for retry`);
    }
  }

  console.log(
    `[notifySweep] complete — sent: ${sent}, opted-out: ${skippedOptOut}, race-skipped: ${skippedRace}`,
  );
}

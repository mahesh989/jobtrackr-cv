import { db } from "../db/client.js";
import { Resend } from "resend";
const _resendApiKey = process.env.RESEND_API_KEY ?? "";
const resend = _resendApiKey ? new Resend(_resendApiKey) : null;
const fromEmail = process.env.RESEND_FROM_EMAIL ?? "JobTrackr <noreply@jobtrackr.app>";
import { buildDigestHtml, type DigestJob, type DigestProfile } from "./digestEmail.js";

export async function runWeeklyDigest(): Promise<void> {
  if (!resend) {
    console.warn("[digest] RESEND_API_KEY not set — skipping weekly digest");
    return;
  }

  console.log("[digest] starting weekly digest...");

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // Load all active profiles
  const { data: profiles, error: profilesError } = await db
    .from("search_profiles")
    .select("id, name, user_id")
    .eq("is_active", true);

  if (profilesError || !profiles?.length) {
    console.log("[digest] no active profiles:", profilesError?.message ?? "empty");
    return;
  }

  // Load user emails for all affected users
  const userIds = [...new Set(profiles.map((p) => p.user_id))];
  const { data: users } = await db
    .from("users")
    .select("id, email")
    .in("id", userIds);

  const emailMap = new Map((users ?? []).map((u) => [u.id as string, u.email as string]));

  // Group profiles by user
  const byUser = new Map<string, typeof profiles>();
  for (const p of profiles) {
    if (!byUser.has(p.user_id)) byUser.set(p.user_id, []);
    byUser.get(p.user_id)!.push(p);
  }

  let sent = 0;
  let skipped = 0;

  for (const [userId, userProfiles] of byUser) {
    const email = emailMap.get(userId);
    if (!email) {
      console.warn(`[digest] no email for user ${userId} — skipping`);
      skipped++;
      continue;
    }

    const digestProfiles: DigestProfile[] = [];

    for (const profile of userProfiles) {
      const { data: jobs } = await db
        .from("jobs")
        .select("title, company, location, url, visa_likelihood, source")
        .eq("profile_id", profile.id)
        .eq("is_expired", false)
        .eq("is_dead_link", false)
        .is("dismissed_at", null)
        .is("applied_at", null)
        .gte("created_at", sevenDaysAgo)
        .order("created_at", { ascending: false, nullsFirst: false })
        .limit(10);

      if (jobs?.length) {
        digestProfiles.push({ name: profile.name, jobs: jobs as DigestJob[] });
      }
    }

    if (digestProfiles.length === 0) {
      console.log(`[digest] no new jobs for ${email} — skipping`);
      skipped++;
      continue;
    }

    const totalJobs = digestProfiles.reduce((n, p) => n + p.jobs.length, 0);
    const html = buildDigestHtml(digestProfiles);

    const { error: sendError } = await resend.emails.send({
      from: fromEmail,
      to: email,
      subject: `JobTrackr — ${totalJobs} new job${totalJobs === 1 ? "" : "s"} this week`,
      html,
    });

    if (sendError) {
      console.error(`[digest] send failed for ${email}:`, sendError);
    } else {
      console.log(`[digest] sent ${totalJobs} jobs to ${email}`);
      sent++;
    }
  }

  console.log(`[digest] complete — sent: ${sent}, skipped: ${skipped}`);
}

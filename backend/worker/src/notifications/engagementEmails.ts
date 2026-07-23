// Engagement email templates — inactivity warning, pause notice, new-jobs
// batch — matching the visual language of digestEmail.ts (dark inline-style
// card, same font stack, same footer treatment).
//
// All three builders/senders guard `resend` being null, always send from
// `fromEmail`, and catch + log rather than throw — a notification-email
// failure must never take down the caller (the gate or the sweep).

import { createHmac } from "crypto";
import { esc } from "./digestEmail.js";
import { Resend } from "resend";
const _resendApiKey = process.env.RESEND_API_KEY ?? "";
const resend = _resendApiKey ? new Resend(_resendApiKey) : null;
const fromEmail = process.env.RESEND_FROM_EMAIL ?? "JobTrackr <noreply@jobtrackr.app>";
import { db } from "../db/client.js";

// APP_URL: no dedicated worker env exists for the public app origin today —
// errorAlert.ts hardcodes "https://jobtrackr.app" for its dashboard link, and
// the frontend's closest equivalent (NEXT_PUBLIC_APP_URL) is only read by
// auth/OAuth routes. We read the same var name here (available to the worker
// if ever set as a Fly secret) with the same production fallback, so behavior
// matches errorAlert.ts today and picks up an explicit override later.
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://jobtrackr.app";

function shell(opts: { preheader: string; heading: string; body: string; footer: string }): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(opts.heading)}</title>
</head>
<body style="margin:0;padding:0;background:#020617;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;-webkit-font-smoothing:antialiased;">
  <div style="max-width:640px;margin:0 auto;padding:32px 20px;">

    <div style="margin-bottom:28px;">
      <span style="color:#60a5fa;font-size:18px;font-weight:800;letter-spacing:-.02em;">JobTrackr</span>
      <h1 style="color:#f1f5f9;font-size:22px;font-weight:700;margin:10px 0 6px;">${esc(opts.heading)}</h1>
    </div>

    ${opts.body}

    <div style="margin-top:40px;padding-top:20px;border-top:1px solid #1e293b;color:#475569;font-size:12px;line-height:1.6;">
      ${opts.footer}
    </div>

  </div>
</body>
</html>`;
}

function button(label: string, href: string): string {
  return `<a href="${esc(href)}" style="display:inline-block;margin-top:20px;padding:10px 20px;background:#2563eb;color:#f8fafc;text-decoration:none;font-size:14px;font-weight:600;border-radius:8px;">${esc(label)}</a>`;
}

async function getUserEmail(userId: string): Promise<string | null> {
  const { data } = await db.from("users").select("email").eq("id", userId).maybeSingle();
  return (data?.email as string | undefined) ?? null;
}

// HMAC key selection: JOBTRACKR_HMAC_SECRET is already a shared secret set on
// BOTH sides today (backend/worker/src/lib/cvBackendHmac.ts and
// frontend/web/src/lib/cvBackend.ts both read it, for the web<->cv-backend
// HMAC envelope) — reused here as the unsubscribe-link signing key so no new
// env var is needed. See the frontend counterpart at
// frontend/web/src/app/api/notifications/unsubscribe/route.ts.
function hmacSig(userId: string): string {
  const key = process.env.JOBTRACKR_HMAC_SECRET ?? "";
  return createHmac("sha256", key).update(userId).digest("hex");
}

export function unsubscribeUrl(userId: string): string {
  return `${APP_URL}/api/notifications/unsubscribe?uid=${encodeURIComponent(userId)}&sig=${hmacSig(userId)}`;
}

// ── 1. Inactivity warning (14 days) ────────────────────────────────────────

export async function sendInactivityWarningEmail(userId: string): Promise<void> {
  if (!resend) return;
  try {
    const email = await getUserEmail(userId);
    if (!email) {
      console.warn(`[engagementEmails] no email for user ${userId} — skipping warning`);
      return;
    }

    const body = `
    <p style="color:#cbd5e1;font-size:14px;line-height:1.6;">
      We haven't seen you in JobTrackr for a couple of weeks. Your job alerts are still
      active and fetching new matches on schedule — if you're still job hunting, there's
      nothing you need to do.
    </p>
    <p style="color:#94a3b8;font-size:13px;line-height:1.6;margin-top:12px;">
      Heads up: alerts pause automatically after 30 days away, to avoid running searches
      no one's looking at.
    </p>
    ${button("Open JobTrackr", `${APP_URL}/dashboard`)}`;

    const html = shell({
      preheader: "Your JobTrackr alerts are still active",
      heading: "Still job hunting?",
      body,
      footer: "You're receiving this because you have active JobTrackr search profiles.",
    });

    const { error } = await resend.emails.send({
      from: fromEmail,
      to: email,
      subject: "Still job hunting? Your JobTrackr alerts are active",
      html,
    });
    if (error) console.error(`[engagementEmails] warning send failed for ${email}:`, error);
  } catch (err) {
    console.error("[engagementEmails] sendInactivityWarningEmail error:", err);
  }
}

// ── 2. Paused notice (30 days inactive, or dead subscription) ─────────────

export async function sendPausedEmail(userId: string, reason: "inactivity" | "subscription"): Promise<void> {
  if (!resend) return;
  try {
    const email = await getUserEmail(userId);
    if (!email) {
      console.warn(`[engagementEmails] no email for user ${userId} — skipping pause notice`);
      return;
    }

    const explanation =
      reason === "inactivity"
        ? "You haven't visited JobTrackr in 30 days, so we paused automatic job fetching to keep things tidy. You can resume any time from your dashboard."
        : "Your subscription or trial has ended, so we paused automatic job fetching. Renew to resume.";

    const body = `
    <p style="color:#cbd5e1;font-size:14px;line-height:1.6;">
      ${explanation}
    </p>
    ${button("Open JobTrackr", `${APP_URL}/dashboard`)}`;

    const html = shell({
      preheader: "Your JobTrackr job alerts were paused",
      heading: "We've paused your job alerts",
      body,
      footer: "You're receiving this because you had active JobTrackr search profiles.",
    });

    const { error } = await resend.emails.send({
      from: fromEmail,
      to: email,
      subject: "We've paused your job alerts",
      html,
    });
    if (error) console.error(`[engagementEmails] pause send failed for ${email}:`, error);
  } catch (err) {
    console.error("[engagementEmails] sendPausedEmail error:", err);
  }
}

// ── 3. New jobs batch (per sweep window) ───────────────────────────────────

export interface NewJobsProfileGroup {
  profileName: string;
  jobsSaved: number;
}

export interface NewJobsFlavorItem {
  title: string;
  company: string;
}

export async function sendNewJobsEmail(
  userId: string,
  email: string,
  groups: NewJobsProfileGroup[],
  flavor: NewJobsFlavorItem[],
): Promise<boolean> {
  if (!resend) return false;
  try {
    const total = groups.reduce((n, g) => n + g.jobsSaved, 0);
    const singleProfile = groups.length === 1;
    const subject = singleProfile
      ? `${total} new job${total === 1 ? "" : "s"} found for you — ${groups[0].profileName}`
      : `${total} new job${total === 1 ? "" : "s"} found for you`;

    const profileLines = groups
      .map(
        (g) => `
      <div style="padding:10px 12px;border-bottom:1px solid #1e293b;color:#e5e7eb;font-size:14px;">
        <strong>${esc(g.profileName)}</strong> — ${g.jobsSaved} new job${g.jobsSaved === 1 ? "" : "s"}
      </div>`,
      )
      .join("");

    const flavorList =
      flavor.length > 0
        ? `
    <h2 style="color:#e5e7eb;font-size:14px;margin:24px 0 8px;font-weight:600;">Latest:</h2>
    <ul style="margin:0;padding-left:18px;color:#9ca3af;font-size:13px;line-height:1.8;">
      ${flavor.map((f) => `<li>${esc(f.title)} — ${esc(f.company)}</li>`).join("")}
    </ul>`
        : "";

    const unsubUrl = unsubscribeUrl(userId);

    const body = `
    <p style="color:#64748b;font-size:14px;margin:0 0 16px;">
      ${total} new job${total === 1 ? "" : "s"} across your profiles.
    </p>
    <div style="border:1px solid #1e293b;border-radius:8px;overflow:hidden;background:#0f172a;">
      ${profileLines}
    </div>
    ${flavorList}
    ${button("View new jobs", `${APP_URL}/dashboard`)}`;

    const html = shell({
      preheader: subject,
      heading: `${total} new job${total === 1 ? "" : "s"} found`,
      body,
      footer: `You're receiving this because job alerts are on. <a href="${esc(unsubUrl)}" style="color:#60a5fa;">Unsubscribe</a>.`,
    });

    const { error } = await resend.emails.send({
      from: fromEmail,
      to: email,
      subject,
      html,
      headers: { "List-Unsubscribe": `<${unsubUrl}>` },
    });
    if (error) {
      console.error(`[engagementEmails] new-jobs send failed for ${email}:`, error);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[engagementEmails] sendNewJobsEmail error:", err);
    return false;
  }
}

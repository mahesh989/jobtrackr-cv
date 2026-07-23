// Pipeline failure alert — emails the founder when a pipeline run fatally fails.
// No-ops silently when RESEND_API_KEY or FOUNDER_ALERT_EMAIL are not configured.

import { Resend } from "resend";
const _resendApiKey = process.env.RESEND_API_KEY ?? "";
const resend = _resendApiKey ? new Resend(_resendApiKey) : null;
const fromEmail = process.env.RESEND_FROM_EMAIL ?? "JobTrackr <noreply@jobtrackr.app>";
import { connection } from "../queue/connection.js";

// Dedup/rate-limit: suppress repeat alerts for the same key within this
// window, so a systemic failure (e.g. a bad AI API key breaking every run)
// sends one email, not one per run. Same Redis TTL-counter pattern as
// pipeline/healthTracker.ts.
const ALERT_DEDUP_TTL_SECONDS = 60 * 60; // 1 hour
const ALERT_DEDUP_PREFIX = "jobtrackr:alert:sent:";

async function shouldSuppress(dedupKey: string): Promise<boolean> {
  const key = `${ALERT_DEDUP_PREFIX}${dedupKey}`;
  // SET ... NX EX: only the first caller within the window gets `OK`
  // (i.e. permission to send); everyone else within the TTL gets null.
  const acquired = await connection.set(key, "1", "EX", ALERT_DEDUP_TTL_SECONDS, "NX");
  return acquired === null;
}

export type FailureKind = "pipeline_fatal" | "stale_crash";

// Fixed (non-per-profile) dedup key for worker-restart alerts — a crash
// loop should send one email per dedup window, not one per restart.
const WORKER_RESTART_DEDUP_KEY = "worker:restart";

export async function sendPipelineFailureAlert(
  profileId: string,
  errorMessage: string,
  kind: FailureKind = "pipeline_fatal"
): Promise<void> {
  const alertEmail = process.env.FOUNDER_ALERT_EMAIL;
  if (!alertEmail || !resend) return;

  if (await shouldSuppress(`profile:${profileId}`)) {
    console.log(`[errorAlert] suppressed duplicate alert for profile ${profileId} (within ${ALERT_DEDUP_TTL_SECONDS}s window)`);
    return;
  }

  const timestamp = new Date().toLocaleString("en-AU", { timeZone: "Australia/Sydney" });
  const kindLabel =
    kind === "stale_crash" ? "Worker crash / OOM (detected via stale run lock)" : "Pipeline logic error";

  try {
    await resend.emails.send({
      from: fromEmail,
      to: alertEmail,
      subject: `[JobTrackr] Pipeline failure — ${timestamp}`,
      html: `
        <div style="font-family:sans-serif;max-width:520px;margin:0 auto">
          <h2 style="color:#ef4444">Pipeline run failed</h2>
          <table style="width:100%;border-collapse:collapse;font-size:14px">
            <tr>
              <td style="padding:6px 12px 6px 0;color:#6b7280;white-space:nowrap">Profile ID</td>
              <td style="padding:6px 0;font-family:monospace">${profileId}</td>
            </tr>
            <tr>
              <td style="padding:6px 12px 6px 0;color:#6b7280">Failure type</td>
              <td style="padding:6px 0">${kindLabel}</td>
            </tr>
            <tr>
              <td style="padding:6px 12px 6px 0;color:#6b7280">Time (AEST)</td>
              <td style="padding:6px 0">${timestamp}</td>
            </tr>
          </table>
          <h3 style="margin-top:20px">Error</h3>
          <pre style="background:#1f2937;color:#f87171;padding:12px;border-radius:6px;overflow:auto;font-size:13px">${errorMessage}</pre>
          <p style="color:#9ca3af;font-size:13px;margin-top:20px">
            Check the <a href="https://jobtrackr.app/dashboard" style="color:#60a5fa">run history</a> for details.
          </p>
        </div>
      `,
    });
    console.log(`[errorAlert] failure alert sent to ${alertEmail}`);
  } catch (err) {
    console.error("[errorAlert] failed to send alert:", err);
  }
}

/**
 * Worker-restart alert — emails the founder when the worker process comes
 * back up after a shutdown that skipped the graceful SIGTERM path (crash,
 * OOM-kill, or a force-stop). Not tied to any profile, so it's a distinct
 * function rather than sendPipelineFailureAlert with a fake profileId —
 * reuses the same Resend client, env-gating, and SET NX EX dedup pattern,
 * just keyed on a fixed key instead of `profile:<id>`.
 *
 * `detail` is either the real error (uncaughtException/unhandledRejection
 * path — the process caught its own death and could inspect the error) or
 * a generic explanation (startup-marker path — the previous process never
 * got a chance to say anything, so there's no real error to report, only
 * the fact that the shutdown wasn't graceful).
 */
export async function sendWorkerRestartAlert(
  detail: string,
  lastKnownRun?: { profileId: string; status: string; startedAt: string } | null
): Promise<void> {
  const alertEmail = process.env.FOUNDER_ALERT_EMAIL;
  if (!alertEmail || !resend) return;

  if (await shouldSuppress(WORKER_RESTART_DEDUP_KEY)) {
    console.log(`[errorAlert] suppressed duplicate worker-restart alert (within ${ALERT_DEDUP_TTL_SECONDS}s window)`);
    return;
  }

  const timestamp = new Date().toLocaleString("en-AU", { timeZone: "Australia/Sydney" });

  const lastRunRow = lastKnownRun
    ? `
            <tr>
              <td style="padding:6px 12px 6px 0;color:#6b7280;white-space:nowrap">Last known run</td>
              <td style="padding:6px 0;font-family:monospace">${lastKnownRun.status} · profile ${lastKnownRun.profileId} · started ${lastKnownRun.startedAt}</td>
            </tr>`
    : "";

  try {
    await resend.emails.send({
      from: fromEmail,
      to: alertEmail,
      subject: `[JobTrackr] Worker restarted unexpectedly — ${timestamp}`,
      html: `
        <div style="font-family:sans-serif;max-width:520px;margin:0 auto">
          <h2 style="color:#ef4444">Worker restarted without a graceful shutdown</h2>
          <table style="width:100%;border-collapse:collapse;font-size:14px">
            <tr>
              <td style="padding:6px 12px 6px 0;color:#6b7280;white-space:nowrap">Time (AEST)</td>
              <td style="padding:6px 0">${timestamp}</td>
            </tr>${lastRunRow}
          </table>
          <h3 style="margin-top:20px">Detail</h3>
          <pre style="background:#1f2937;color:#f87171;padding:12px;border-radius:6px;overflow:auto;font-size:13px">${detail}</pre>
          <p style="color:#9ca3af;font-size:13px;margin-top:20px">
            The worker recovered on its own (Fly's restart policy) — this is a
            notification, not an action item, unless it keeps happening.
          </p>
        </div>
      `,
    });
    console.log(`[errorAlert] worker-restart alert sent to ${alertEmail}`);
  } catch (err) {
    console.error("[errorAlert] failed to send worker-restart alert:", err);
  }
}

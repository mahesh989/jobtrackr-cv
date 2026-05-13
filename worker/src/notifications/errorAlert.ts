// Pipeline failure alert — emails the founder when a pipeline run fatally fails.
// No-ops silently when RESEND_API_KEY or FOUNDER_ALERT_EMAIL are not configured.

import { resend, fromEmail } from "./resendClient.js";

export async function sendPipelineFailureAlert(profileId: string, errorMessage: string): Promise<void> {
  const alertEmail = process.env.FOUNDER_ALERT_EMAIL;
  if (!alertEmail || !resend) return;

  const timestamp = new Date().toLocaleString("en-AU", { timeZone: "Australia/Sydney" });

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

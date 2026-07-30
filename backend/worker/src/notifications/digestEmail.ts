export interface DigestJob {
  title: string;
  company: string;
  location: string;
  url: string;
  visa_likelihood: number | null;
  source: string;
}

export interface DigestProfile {
  name: string;
  jobs: DigestJob[];
}

export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pct(v: number | null): string {
  return v !== null ? `${Math.round(v * 100)}%` : "–";
}

export function buildDigestHtml(profiles: DigestProfile[]): string {
  const totalJobs = profiles.reduce((n, p) => n + p.jobs.length, 0);

  const profileSections = profiles
    .map((p) => {
      const rows = p.jobs
        .map(
          (j) => `
      <tr>
        <td style="padding:10px 12px;border-bottom:1px solid #F1F5F9;vertical-align:top;">
          <a href="${esc(j.url)}" style="color:#3B82F6;text-decoration:none;font-weight:500;">${esc(j.title)}</a>
          <div style="color:#64748B;font-size:13px;margin-top:2px;">
            ${esc(j.company)}${j.location ? ` · ${esc(j.location)}` : ""}
          </div>
        </td>
        <td style="padding:10px 12px;border-bottom:1px solid #F1F5F9;color:#64748B;font-size:13px;white-space:nowrap;vertical-align:top;">${pct(j.visa_likelihood)}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #F1F5F9;color:#94A3B8;font-size:12px;vertical-align:top;">${esc(j.source)}</td>
      </tr>`
        )
        .join("");

      return `
    <h2 style="color:#0F172A;font-size:15px;margin:28px 0 10px;font-weight:600;">${esc(p.name)}</h2>
    <table width="100%" cellpadding="0" cellspacing="0"
      style="border-collapse:collapse;border:1px solid #E2E8F0;border-radius:8px;overflow:hidden;background:#FFFFFF;">
      <thead>
        <tr style="background:#F1F5F9;">
          <th style="padding:8px 12px;text-align:left;color:#64748B;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;">Job</th>
          <th style="padding:8px 12px;text-align:left;color:#64748B;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;">Visa</th>
          <th style="padding:8px 12px;text-align:left;color:#64748B;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;">Source</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Your weekly job digest</title>
</head>
<body style="margin:0;padding:0;background:#F1F5F9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;-webkit-font-smoothing:antialiased;">
  <div style="max-width:640px;margin:0 auto;padding:32px 20px;">

    <div style="margin-bottom:20px;">
      <span style="color:#3B82F6;font-size:18px;font-weight:800;letter-spacing:-.02em;">JobTrackr</span>
    </div>

    <div style="background:#FFFFFF;border:1px solid #E2E8F0;border-radius:12px;padding:28px;box-shadow:0 12px 28px -18px rgba(16,24,40,.15);">
      <h1 style="color:#0F172A;font-size:20px;font-weight:700;margin:0 0 6px;">Your weekly job digest</h1>
      <p style="color:#64748B;font-size:14px;margin:0;">
        ${totalJobs} new top job${totalJobs === 1 ? "" : "s"} across your profiles this week
      </p>

      ${profileSections}
    </div>

    <div style="margin-top:24px;padding:0 4px;color:#64748B;font-size:12px;line-height:1.6;">
      You're receiving this because you have active JobTrackr search profiles.
      To stop, pause your profiles from the dashboard.
    </div>

  </div>
</body>
</html>`;
}

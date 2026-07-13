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
        <td style="padding:10px 12px;border-bottom:1px solid #1e293b;vertical-align:top;">
          <a href="${esc(j.url)}" style="color:#60a5fa;text-decoration:none;font-weight:500;">${esc(j.title)}</a>
          <div style="color:#9ca3af;font-size:13px;margin-top:2px;">
            ${esc(j.company)}${j.location ? ` · ${esc(j.location)}` : ""}
          </div>
        </td>
        <td style="padding:10px 12px;border-bottom:1px solid #1e293b;color:#9ca3af;font-size:13px;white-space:nowrap;vertical-align:top;">${pct(j.visa_likelihood)}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #1e293b;color:#6b7280;font-size:12px;vertical-align:top;">${esc(j.source)}</td>
      </tr>`
        )
        .join("");

      return `
    <h2 style="color:#e5e7eb;font-size:15px;margin:28px 0 10px;font-weight:600;">${esc(p.name)}</h2>
    <table width="100%" cellpadding="0" cellspacing="0"
      style="border-collapse:collapse;border:1px solid #1e293b;border-radius:8px;overflow:hidden;background:#0f172a;">
      <thead>
        <tr style="background:#1e293b;">
          <th style="padding:8px 12px;text-align:left;color:#6b7280;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;">Job</th>
          <th style="padding:8px 12px;text-align:left;color:#6b7280;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;">Visa</th>
          <th style="padding:8px 12px;text-align:left;color:#6b7280;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;">Source</th>
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
<body style="margin:0;padding:0;background:#020617;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;-webkit-font-smoothing:antialiased;">
  <div style="max-width:640px;margin:0 auto;padding:32px 20px;">

    <div style="margin-bottom:28px;">
      <span style="color:#60a5fa;font-size:18px;font-weight:800;letter-spacing:-.02em;">JobTrackr</span>
      <h1 style="color:#f1f5f9;font-size:22px;font-weight:700;margin:10px 0 6px;">Your weekly job digest</h1>
      <p style="color:#64748b;font-size:14px;margin:0;">
        ${totalJobs} new top job${totalJobs === 1 ? "" : "s"} across your profiles this week
      </p>
    </div>

    ${profileSections}

    <div style="margin-top:40px;padding-top:20px;border-top:1px solid #1e293b;color:#475569;font-size:12px;line-height:1.6;">
      You're receiving this because you have active JobTrackr search profiles.
      To stop, pause your profiles from the dashboard.
    </div>

  </div>
</body>
</html>`;
}

/**
 * Send an email via the Gmail API (users.messages.send).
 * Builds an RFC-2822 multipart/mixed MIME message with an optional PDF attachment.
 * Only call from server-side code.
 */

export interface EmailAttachment {
  filename:    string;
  contentType: string;
  data:        Buffer;
}

export interface GmailSendOptions {
  from:         string;         // "Name <email>" or plain email
  to:           string;
  subject:      string;
  body:         string;         // plain text
  attachments?: EmailAttachment[];
}

export async function sendViaGmail(
  accessToken: string,
  opts:        GmailSendOptions,
): Promise<void> {
  const boundary = `---=_jt_${Date.now().toString(36)}`;

  const lines: string[] = [
    `MIME-Version: 1.0`,
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    `Subject: ${opts.subject}`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset=UTF-8`,
    `Content-Transfer-Encoding: base64`,
    ``,
    Buffer.from(opts.body, "utf-8").toString("base64"),
  ];

  for (const att of opts.attachments ?? []) {
    lines.push(
      `--${boundary}`,
      `Content-Type: ${att.contentType}; name="${att.filename}"`,
      `Content-Disposition: attachment; filename="${att.filename}"`,
      `Content-Transfer-Encoding: base64`,
      ``,
      att.data.toString("base64"),
    );
  }

  lines.push(`--${boundary}--`);

  // Gmail requires base64url (no padding, + → -, / → _)
  const raw = Buffer.from(lines.join("\r\n"), "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const res = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    {
      method:  "POST",
      headers: {
        Authorization:  `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw }),
    },
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Gmail send failed ${res.status}: ${text}`);
  }
}

/**
 * Send an email via the Microsoft Graph API (me/sendMail).
 * Only call from server-side code.
 */

interface OutlookAttachment {
  filename:    string;
  contentType: string;
  data:        Buffer;
}

export interface OutlookSendOptions {
  to:           string;
  subject:      string;
  body:         string;           // plain text
  attachments?: OutlookAttachment[];
}

// Graph's toRecipients[].emailAddress.address field wants a bare SMTP
// address — callers (see sendApplication.ts's toAddress) pass the combined
// "Display Name <email>" form Gmail's raw-MIME To: header accepts, which
// Graph either rejects outright or silently mishandles. Split the two apart
// and carry the name via the address object's own `name` field instead.
function parseRecipient(to: string): { name?: string; address: string } {
  const match = to.match(/^\s*(.*?)\s*<([^<>]+)>\s*$/);
  if (match && match[2].trim()) {
    const name = match[1].trim();
    return name ? { name, address: match[2].trim() } : { address: match[2].trim() };
  }
  return { address: to.trim() };
}

export async function sendViaOutlook(
  accessToken: string,
  opts:        OutlookSendOptions,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const message: Record<string, any> = {
    subject: opts.subject,
    body: {
      contentType: "Text",
      content:     opts.body,
    },
    toRecipients: [
      { emailAddress: parseRecipient(opts.to) },
    ],
  };

  const atts = opts.attachments ?? [];
  if (atts.length > 0) {
    message.attachments = atts.map((att) => ({
      "@odata.type": "#microsoft.graph.fileAttachment",
      name:          att.filename,
      contentType:   att.contentType,
      contentBytes:  att.data.toString("base64"),
    }));
  }

  const res = await fetch(
    "https://graph.microsoft.com/v1.0/me/sendMail",
    {
      method:  "POST",
      headers: {
        Authorization:  `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message, saveToSentItems: true }),
    },
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Outlook send failed ${res.status}: ${text}`);
  }
  // Graph API returns 202 No Content on success
}

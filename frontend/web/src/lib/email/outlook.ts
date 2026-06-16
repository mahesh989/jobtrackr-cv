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
      { emailAddress: { address: opts.to } },
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

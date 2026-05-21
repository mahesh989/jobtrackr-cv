/**
 * Send an email via the Microsoft Graph API (me/sendMail).
 * Only call from server-side code.
 */

export interface OutlookSendOptions {
  to:      string;
  subject: string;
  body:    string;           // plain text
  attachment?: {
    filename:    string;
    contentType: string;
    data:        Buffer;
  };
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

  if (opts.attachment) {
    message.attachments = [
      {
        "@odata.type": "#microsoft.graph.fileAttachment",
        name:          opts.attachment.filename,
        contentType:   opts.attachment.contentType,
        contentBytes:  opts.attachment.data.toString("base64"),
      },
    ];
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

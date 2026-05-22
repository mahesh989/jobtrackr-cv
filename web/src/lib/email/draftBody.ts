/**
 * Default email subject + body composer for outgoing job applications.
 *
 * Used by:
 *   • GET  /api/applications/[letter_id]/email-draft → prefills the compose modal
 *   • POST /api/applications/[letter_id]/send-email  → fallback when client
 *                                                      sends no overrides
 *
 * Keep both call sites passing the SAME inputs so the prefilled draft a user
 * sees in the modal is byte-identical to what would have been sent without
 * the modal (zero surprise).
 */

export interface DraftInput {
  jobTitle:       string | null | undefined;
  company:        string | null | undefined;
  hiringManager:  string | null | undefined;
  userName:       string | null | undefined;
}

export interface EmailDraft {
  subject: string;
  body:    string;
}

export function buildDefaultEmailDraft(input: DraftInput): EmailDraft {
  const jobTitle = (input.jobTitle ?? "").trim() || "the role";
  const company  = (input.company  ?? "").trim() || "your company";
  const hm       = (input.hiringManager ?? "").trim();
  const name     = (input.userName ?? "").trim();

  const greeting = hm
    ? `Dear ${hm.split(/\s+/)[0]},`        // first name only for a warmer feel
    : "Dear Hiring Team,";

  const signoff = name
    ? `Kind regards,\n${name}`
    : "Kind regards,";

  const body = [
    greeting,
    "",
    `Please find attached my application for the ${jobTitle} role at ${company}. My tailored CV and cover letter are included for your review.`,
    "",
    "I'd welcome the chance to discuss how my background can contribute to your team.",
    "",
    signoff,
  ].join("\n");

  return {
    subject: `Application for ${jobTitle} at ${company}`,
    body,
  };
}

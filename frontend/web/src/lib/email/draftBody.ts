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
  const jobTitle = (input.jobTitle ?? "").trim() || "the advertised role";
  const company  = (input.company  ?? "").trim() || "your organisation";
  const hm       = (input.hiringManager ?? "").trim();
  const name     = (input.userName ?? "").trim();

  // First-name-only for warmth when the hiring manager is known; falls back to
  // the safe-but-unspecific "Hiring Team" otherwise.
  const greeting = hm
    ? `Dear ${hm.split(/\s+/)[0]},`
    : "Dear Hiring Team,";

  const signoff = name
    ? `Kind regards,\n${name}`
    : "Kind regards,";

  // Four paragraphs — interest, what's attached, invitation to talk, thanks —
  // in measured AU/UK professional register. Keeps the body informative but
  // not redundant with the cover-letter PDF that's attached separately.
  const body = [
    greeting,
    "",
    `I would like to express my interest in the ${jobTitle} position at ${company}. The role aligns closely with my background, and I would welcome the opportunity to contribute to your team.`,
    "",
    "Please find my tailored CV and cover letter attached for your consideration. The cover letter sets out, in more detail, how my experience maps to the responsibilities of the role.",
    "",
    "I would be delighted to discuss my application further at a time that suits you. Please don't hesitate to let me know if any additional information would be helpful.",
    "",
    "Thank you for your time, and I look forward to hearing from you.",
    "",
    signoff,
  ].join("\n");

  return {
    subject: `Application for ${jobTitle} at ${company}`,
    body,
  };
}

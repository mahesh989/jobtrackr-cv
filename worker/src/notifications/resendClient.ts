import { Resend } from "resend";

const apiKey = process.env.RESEND_API_KEY ?? "";

// null when RESEND_API_KEY is not configured — callers must guard before use
export const resend = apiKey ? new Resend(apiKey) : null;

export const fromEmail =
  process.env.RESEND_FROM_EMAIL ?? "JobTrackr <noreply@jobtrackr.app>";

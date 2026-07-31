/**
 * Shared Resend client — every notification module (errorAlert, gate,
 * weeklyDigest, newJobsSweep, engagementEmails) sent from the same account
 * with the same null-when-unconfigured guard; this is the one place that
 * reads RESEND_API_KEY / RESEND_FROM_EMAIL.
 */
import { Resend } from "resend";

const _resendApiKey = process.env.RESEND_API_KEY ?? "";

export const resend = _resendApiKey ? new Resend(_resendApiKey) : null;
export const fromEmail = process.env.RESEND_FROM_EMAIL ?? "JobTrackr <noreply@jobtrackr.app>";

import { NextRequest, NextResponse } from "next/server";
import { rateLimit, RATE_LIMIT_MESSAGE } from "@/lib/rateLimit";
import { checkSsoOnly } from "@/features/auth/server";
import { jsonError } from "@/lib/api-utils";

// Identity CHECK only — the actual resetPasswordForEmail() send must happen
// client-side (see ForgotPasswordForm.tsx) so Supabase's PKCE code_verifier
// lands in the user's own browser, not a throwaway server request context.
// Rate-limited since this is an unauthenticated, DB-querying endpoint; no
// Turnstile here since it makes no GoTrue call, so there's no captcha to
// satisfy or single-use token to conflict with.
export async function POST(req: NextRequest) {
  const ip = (req.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim();
  const rl = await rateLimit(`forgot-password:${ip}`, 10, 60);
  if (!rl.allowed) return jsonError(RATE_LIMIT_MESSAGE, 429);

  let body: { email?: unknown };
  try { body = await req.json(); }
  catch { return jsonError("Invalid JSON body", 400); }

  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (!email) return jsonError("Email is required", 422);

  const ssoOnly = await checkSsoOnly(email);
  return NextResponse.json({ ssoOnly });
}

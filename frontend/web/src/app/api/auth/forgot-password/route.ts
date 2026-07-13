import { NextRequest, NextResponse } from "next/server";
import { rateLimit, RATE_LIMIT_MESSAGE } from "@/lib/rateLimit";
import { sendPasswordReset } from "@/modules/auth/server";

// Rate-limited but NOT separately Turnstile-verified here — the captchaToken
// is relayed straight through to Supabase's own resetPasswordForEmail, which
// verifies it natively. Turnstile tokens are single-use; calling
// verifyTurnstile ourselves first would consume the token and make
// Supabase's own check fail. Rate limiting is the abuse guard for the
// generateLink-based SSO-only check specifically, since that branch can
// return before ever reaching Supabase's captcha-gated call.
export async function POST(req: NextRequest) {
  const ip = (req.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim();
  const rl = await rateLimit(`forgot-password:${ip}`, 10, 60);
  if (!rl.allowed) return NextResponse.json({ error: RATE_LIMIT_MESSAGE }, { status: 429 });

  let body: { email?: unknown; captchaToken?: unknown };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (!email) return NextResponse.json({ error: "Email is required" }, { status: 422 });
  const captchaToken = typeof body.captchaToken === "string" ? body.captchaToken : null;

  const redirectTo = `${new URL(req.url).origin}/auth/confirm`;
  const result = await sendPasswordReset(email, redirectTo, captchaToken);

  if (result.error) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json({ ssoOnly: result.ssoOnly });
}

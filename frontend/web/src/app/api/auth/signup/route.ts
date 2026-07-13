/**
 * POST /api/auth/signup — invite-gated, server-side account creation.
 *
 * Thin HTTP shell: rate-limit, bot gate, and input validation live here;
 * the invite claim + account creation live in modules/auth/server/signup.ts
 * (see that file for the security rationale and required Supabase config).
 */

import { NextRequest, NextResponse } from "next/server";
import { rateLimit, RATE_LIMIT_MESSAGE } from "@/lib/rateLimit";
import { verifyTurnstile } from "@/lib/turnstile";
import { signupWithInvite } from "@/modules/auth/server";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(req: NextRequest) {
  // Rate limit by IP — this endpoint creates accounts and sends email, and the
  // invite code is the only secret, so it must be brute-force resistant.
  const ip = (req.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim();
  const rl = await rateLimit(`signup:${ip}`, 10, 60);
  if (!rl.allowed) return NextResponse.json({ error: RATE_LIMIT_MESSAGE }, { status: 429 });

  let body: { email?: unknown; code?: unknown; turnstileToken?: unknown };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  // Bot gate (no-op when TURNSTILE_SECRET_KEY is unset — see lib/turnstile.ts).
  const turnstileToken = typeof body.turnstileToken === "string" ? body.turnstileToken : null;
  if (!(await verifyTurnstile(turnstileToken, ip)).ok) {
    return NextResponse.json({ error: "Bot check failed — please retry." }, { status: 403 });
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const code  = typeof body.code  === "string" ? body.code.trim().toUpperCase()  : "";
  if (!EMAIL_RE.test(email)) return NextResponse.json({ error: "A valid email is required" }, { status: 422 });
  if (!code)                 return NextResponse.json({ error: "An invite code is required" }, { status: 422 });

  const result = await signupWithInvite(email, code, new URL(req.url).origin);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json({ ok: true });
}

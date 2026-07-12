import { NextRequest, NextResponse } from "next/server";
import { rateLimit, RATE_LIMIT_MESSAGE } from "@/lib/rateLimit";
import { verifyTurnstile } from "@/lib/turnstile";
import { validateInviteCode } from "@/modules/auth/server";

export async function POST(request: NextRequest) {
  // This endpoint is unauthenticated — rate limit by client IP to stop invite
  // code brute-force / enumeration.
  const ip = (request.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim();
  const rl = await rateLimit(`invite:${ip}`, 20, 60);
  if (!rl.allowed) return NextResponse.json({ error: RATE_LIMIT_MESSAGE }, { status: 429 });

  const { code, turnstileToken } = await request.json();

  // Bot gate (no-op when TURNSTILE_SECRET_KEY is unset — see lib/turnstile.ts).
  if (!(await verifyTurnstile(turnstileToken, ip)).ok) {
    return NextResponse.json({ error: "Bot check failed — please retry." }, { status: 403 });
  }

  if (!code || typeof code !== "string") {
    return NextResponse.json({ error: "Invite code is required" }, { status: 400 });
  }

  const result = await validateInviteCode(code);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json({ ok: true });
}

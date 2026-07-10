import { createHmac, timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { rateLimit, RATE_LIMIT_MESSAGE } from "@/lib/rateLimit";

// HMAC key selection: JOBTRACKR_HMAC_SECRET is already a shared secret set on
// BOTH sides (backend/worker/src/lib/cvBackendHmac.ts and
// frontend/web/src/lib/cvBackend.ts both read it for the web<->cv-backend
// HMAC envelope) — reused here so no new env var is needed. Worker
// counterpart (link builder): backend/worker/src/notifications/engagementEmails.ts.
function hmacSig(userId: string): string {
  const key = process.env.JOBTRACKR_HMAC_SECRET ?? "";
  return createHmac("sha256", key).update(userId).digest("hex");
}

function verifySig(userId: string, sig: string): boolean {
  const expected = hmacSig(userId);
  const expectedBuf = Buffer.from(expected, "hex");
  const gotBuf = Buffer.from(sig, "hex");
  if (expectedBuf.length !== gotBuf.length) return false;
  return timingSafeEqual(expectedBuf, gotBuf);
}

function htmlResponse(body: string, status = 200) {
  return new NextResponse(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>JobTrackr</title></head>
    <body style="font-family:-apple-system,sans-serif;max-width:480px;margin:80px auto;padding:0 20px;color:#1f2937;">
      ${body}
    </body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

// GET /api/notifications/unsubscribe?uid=...&sig=... — no auth (email link).
export async function GET(request: NextRequest) {
  const uid = request.nextUrl.searchParams.get("uid");
  const sig = request.nextUrl.searchParams.get("sig");

  if (!uid || !sig) {
    return new NextResponse("Missing uid or sig", { status: 400 });
  }

  // Lightly rate-limit per uid — this is an unauthenticated public link.
  const rl = await rateLimit(`unsub:${uid}`, 10, 60);
  if (!rl.allowed) {
    return new NextResponse(RATE_LIMIT_MESSAGE, { status: 429 });
  }

  let valid = false;
  try {
    valid = verifySig(uid, sig);
  } catch {
    valid = false;
  }

  if (!valid) {
    return new NextResponse("Invalid or expired unsubscribe link", { status: 400 });
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("user_engagement")
    .upsert({ user_id: uid, notify_new_jobs: false }, { onConflict: "user_id" });

  if (error) {
    console.error("[unsubscribe] update failed:", error.message);
    return new NextResponse("Something went wrong — please try again.", { status: 500 });
  }

  return htmlResponse(`
    <h1 style="font-size:20px;">You've been unsubscribed</h1>
    <p style="font-size:14px;line-height:1.6;">
      You've been unsubscribed from new-job notifications. You can re-enable them any time in
      <a href="/dashboard/cv" style="color:#2563eb;">Settings</a>.
    </p>
  `);
}

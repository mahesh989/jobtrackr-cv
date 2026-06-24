/**
 * Cloudflare Turnstile server-side token verification (siteverify).
 *
 * Used as an explicit bot gate on unauthenticated, abuse-prone API routes that
 * are NOT already behind Supabase's native auth CAPTCHA (which verifies tokens
 * itself). Posts the token to Cloudflare and returns whether it's valid.
 *
 * Design choices:
 *  - FAIL-CLOSED: a missing token, a missing TURNSTILE_SECRET_KEY, or a network
 *    error all return { ok: false }. This is the opposite of rateLimit's
 *    fail-open posture — a bot gate that silently disables itself is worse than
 *    useless. The ONE deliberate exception is local/dev without the secret set:
 *    see ALLOW_WHEN_UNCONFIGURED below.
 *  - Tokens are single-use and expire 300s after issue; the caller must obtain a
 *    fresh token per request (the client widget resets after each submit).
 *
 * Usage (inside a route handler, alongside the existing rateLimit call):
 *   const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
 *   if (!(await verifyTurnstile(token, ip)).ok) {
 *     return NextResponse.json({ error: "Bot check failed" }, { status: 403 });
 *   }
 */

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export interface TurnstileResult {
  ok: boolean;
  /** Cloudflare error codes when ok=false (e.g. "timeout-or-duplicate"), for logs. */
  errorCodes?: string[];
}

export async function verifyTurnstile(
  token: string | null | undefined,
  ip?: string,
): Promise<TurnstileResult> {
  const secret = process.env.TURNSTILE_SECRET_KEY;

  // When the secret isn't configured (local dev / preview before keys are set),
  // skip the gate rather than locking everyone out. Production MUST set the
  // secret; this branch is a developer-ergonomics escape hatch, not a bypass an
  // attacker can trigger (they can't unset our server env).
  if (!secret) {
    console.warn("[turnstile] TURNSTILE_SECRET_KEY not set — skipping bot check (configure it in production)");
    return { ok: true };
  }

  if (!token || typeof token !== "string") {
    return { ok: false, errorCodes: ["missing-input-response"] };
  }

  try {
    const form = new URLSearchParams();
    form.set("secret", secret);
    form.set("response", token);
    if (ip) form.set("remoteip", ip);

    const res = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
      // Don't let a slow Cloudflare hang the request indefinitely.
      signal: AbortSignal.timeout(5000),
    });

    const data = (await res.json()) as { success?: boolean; "error-codes"?: string[] };
    if (data.success) return { ok: true };
    return { ok: false, errorCodes: data["error-codes"] ?? ["verification-failed"] };
  } catch (err) {
    console.error("[turnstile] siteverify error (failing closed):", err instanceof Error ? err.message : String(err));
    return { ok: false, errorCodes: ["network-error"] };
  }
}

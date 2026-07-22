#!/usr/bin/env node
/**
 * Route auth guard.
 *
 * The Next.js middleware deliberately EXEMPTS /api/** from the auth redirect
 * (see web/src/middleware.ts) — every API route is expected to guard itself.
 * That works today (audited 2026-06-11), but it relies on each new route
 * remembering to check auth. One forgotten check is a data leak.
 *
 * This script codifies that audit. For each route.ts under src/app/api/** it
 * requires BOTH:
 *   (1) an auth-acquisition signal (e.g. getAuthUser / verify_hmac), AND
 *   (2) an enforcement signal (a denial path: 401/403/Unauthorized, a signature
 *       verify that throws, or an HMAC dependency).
 * Requiring (2) as well as (1) is what stops the weak failure mode of a route
 * that imports getAuthUser but never acts on the result.
 *
 * Heuristic, not a proof: it greps source, it does not do dataflow analysis.
 * The durable guarantee is the withAuth()/HMAC wrapper pattern; this guard is
 * the cheap backstop that runs in CI on every route, today.
 *
 * Run: `npm run check:auth` (wired into CI: .github/workflows/ci.yml).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const API_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "src", "app", "api");

// Routes that are intentionally public. Each MUST have a reason and is expected
// to carry its own abuse mitigation (rate limit, signature, etc.).
const PUBLIC_ALLOWLIST = {
  "billing/webhook/route.ts": "Stripe webhook — authenticated by Stripe signature, not user session",
  "auth/forgot-password/route.ts": "public SSO-only identity check (read-only DB function, no GoTrue call) — IP rate-limited (10/60s); the actual password-reset send happens client-side, gated by Supabase's own native captcha check",
  "notifications/unsubscribe/route.ts": "one-click email unsubscribe link — must work unauthenticated by design; gated by an HMAC signature (verifySig, timing-safe compare) + per-uid rate limit, not a user session",
  "user/setup-status/route.ts": "setup-gate probe — unauthenticated callers receive the constant {complete:true, step:1} before any query runs (deliberate graceful no-op, zero data exposure); authenticated reads are RLS-scoped",
};

// (1) The route obtains a caller identity / verifies a signed sender.
const AUTH_SIGNALS = [
  "getAuthUser",
  "auth.getUser",
  "verifyHmac",
  "verify_hmac",
  "X-Signature",
  "x-signature",
  "constructEvent", // Stripe signature verification
  "requireUser",
];

// (2) The route actually DENIES when that identity is missing/invalid. A route
// with (1) but not (2) acquired a user and ignored it — the exact false-green
// the original substring check would have passed.
const ENFORCEMENT_SIGNALS = [
  "401",
  "403",
  "Unauthorized",
  "Forbidden",
  "/auth/login", // browser flows (e.g. OAuth callbacks) deny by redirect to login
  "constructEvent", // throws on bad signature → enforcement is intrinsic
  "verifyHmac",
  "verify_hmac",
];

// requireUser()/requireAdmin() (lib/api-utils.ts) return a ready-made 401/403
// NextResponse — but ONLY if the route actually hands it back. Presence of the
// helper alone is NOT enforcement (a route could destructure `user` and ignore
// `error` — the exact false-green this guard exists to catch). So enforcement
// is only credited when the file also RETURNS a *err*/error variable, i.e. the
// idiomatic `if (authErr) return authErr;` / `if (error) return error;`.
const RETURNS_HELPER_ERROR = /if\s*\(\s*\w*[eE]rr\w*\s*\)\s*\{?\s*return\b/;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name === "route.ts") out.push(p);
  }
  return out;
}

const offenders = [];
for (const file of walk(API_DIR)) {
  const rel = relative(API_DIR, file).split("\\").join("/");
  if (Object.prototype.hasOwnProperty.call(PUBLIC_ALLOWLIST, rel)) continue;
  const src = readFileSync(file, "utf8");
  const hasAuth = AUTH_SIGNALS.some((s) => src.includes(s));
  const usesAuthHelper = /require(User|Admin)\s*\(/.test(src);
  const hasEnforcement =
    ENFORCEMENT_SIGNALS.some((s) => src.includes(s)) ||
    (usesAuthHelper && RETURNS_HELPER_ERROR.test(src));
  if (!hasAuth) offenders.push(`${rel} — no auth-acquisition signal`);
  else if (!hasEnforcement) offenders.push(`${rel} — acquires a user but no denial path (401/403)`);
}

if (offenders.length) {
  console.error("\n✗ API routes that don't provably guard themselves:\n");
  for (const o of offenders) console.error("   • " + o);
  console.error(
    "\nEither add an auth check (getAuthUser / verifyHmac / signature verify),\n" +
      "or, if the route is genuinely public, add it to PUBLIC_ALLOWLIST in\n" +
      "web/scripts/check-route-auth.mjs with a reason and its own abuse mitigation.\n",
  );
  process.exit(1);
}

console.log(`✓ route-auth guard: all API routes guard themselves or are allowlisted (${Object.keys(PUBLIC_ALLOWLIST).length} public).`);

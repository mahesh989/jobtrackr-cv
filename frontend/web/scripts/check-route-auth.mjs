#!/usr/bin/env node
/**
 * Route auth guard — structural edition.
 *
 * The Next.js middleware deliberately EXEMPTS /api/** from the auth redirect
 * (see web/src/middleware.ts) — every API route is expected to guard itself.
 *
 * Since 2026-07-23 the canonical pattern is the withUser()/withAdmin() wrapper
 * (lib/api-utils.ts): the wrapper acquires the session and denies with 401/403
 * BEFORE the handler runs, so a wrapped route is structurally incapable of
 * skipping auth. This guard therefore checks membership in one of four groups:
 *
 *   1. wrapper      — exports go through withUser( / withAdmin(
 *   2. signature    — Stripe constructEvent / HMAC verify (throws on bad sig)
 *   3. redirect     — browser flows that deny by redirecting to /auth/login
 *                     (OAuth callbacks, admin view-as)
 *   4. allowlisted  — intentionally public, each with a reason + its own
 *                     abuse mitigation
 *
 * Anything else fails CI. No grep-for-401 heuristics anymore — a route either
 * uses a structural guard or must be explicitly justified below.
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
  "auth/forgot-password/route.ts": "public SSO-only identity check (read-only DB function, no GoTrue call) — IP rate-limited (10/60s); the actual password-reset send happens client-side, gated by Supabase's own native captcha check",
  "user/setup-status/route.ts": "setup-gate probe — unauthenticated callers receive the constant {complete:true, step:1} before any query runs (deliberate graceful no-op, zero data exposure); authenticated reads are RLS-scoped",
};

// Signature-verified routes: authenticated by a cryptographic check that
// throws/denies intrinsically, not by user session.
const SIGNATURE_SIGNALS = ["constructEvent", "verifyHmac", "verify_hmac", "verifySig"];

// Redirect-denial browser flows: unauthenticated callers are redirected to
// login (or /) rather than 401'd. Must contain BOTH an auth acquisition and
// a redirect denial to qualify.
const REDIRECT_ROUTES = new Set([
  "admin/view-as/route.ts",
  "auth/email/google/callback/route.ts",
  "auth/email/outlook/callback/route.ts",
]);

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

  // Group 1: structural wrapper. Every exported HTTP method must be wrapped —
  // one unwrapped `export async function METHOD` alongside wrapped ones is
  // exactly the forgotten-auth hole this guard exists to catch.
  const usesWrapper = /export const (GET|POST|PUT|PATCH|DELETE|HEAD) = with(User|Admin)\(/.test(src);
  const bareExports = [...src.matchAll(/export (?:async )?function (GET|POST|PUT|PATCH|DELETE|HEAD)\b/g)].map((m) => m[1]);

  if (usesWrapper && bareExports.length === 0) continue;

  // Group 2: signature-verified.
  if (SIGNATURE_SIGNALS.some((s) => src.includes(s))) continue;

  // Group 3: redirect-denial browser flow.
  if (REDIRECT_ROUTES.has(rel)) {
    const acquires = src.includes("auth.getUser") || src.includes("requireAdmin");
    const denies = src.includes("/auth/login") || /NextResponse\.redirect/.test(src);
    if (acquires && denies) continue;
    offenders.push(`${rel} — listed as redirect-denial but missing acquire/deny signals`);
    continue;
  }

  if (usesWrapper && bareExports.length > 0) {
    offenders.push(`${rel} — mixes wrapped and BARE exports (${bareExports.join(", ")}) — wrap every method`);
  } else {
    offenders.push(`${rel} — no structural guard (withUser/withAdmin), no signature verify, not allowlisted`);
  }
}

if (offenders.length) {
  console.error("\n✗ API routes that don't provably guard themselves:\n");
  for (const o of offenders) console.error("   • " + o);
  console.error(
    "\nWrap handlers in withUser()/withAdmin() from @/lib/api-utils (the\n" +
      "canonical pattern), verify a signature, or — if the route is genuinely\n" +
      "public — add it to PUBLIC_ALLOWLIST in web/scripts/check-route-auth.mjs\n" +
      "with a reason and its own abuse mitigation.\n",
  );
  process.exit(1);
}

console.log(`✓ route-auth guard: all API routes use structural auth or are justified (${Object.keys(PUBLIC_ALLOWLIST).length} public, ${REDIRECT_ROUTES.size} redirect-flow).`);

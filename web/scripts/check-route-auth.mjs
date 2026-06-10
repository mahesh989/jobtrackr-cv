#!/usr/bin/env node
/**
 * Route auth guard.
 *
 * The Next.js middleware deliberately EXEMPTS /api/** from the auth redirect
 * (see web/src/middleware.ts) — every API route is expected to guard itself.
 * That works today (audited 2026-06-11), but it relies on each new route
 * remembering to check auth. One forgotten check is a data leak.
 *
 * This script codifies that audit: it fails if any route.ts under
 * src/app/api/** contains no recognised authorisation signal, unless the route
 * is on the explicit PUBLIC allowlist below (with a reason).
 *
 * Run: `npm run check:auth` (wire into CI before deploy).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const API_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "src", "app", "api");

// Routes that are intentionally public. Each MUST have a reason and is expected
// to carry its own abuse mitigation (rate limit, signature, etc.).
const PUBLIC_ALLOWLIST = {
  "auth/signup/route.ts": "public account creation — invite-gated + IP rate-limited",
  "auth/validate-invite/route.ts": "pre-signup invite check — IP rate-limited",
  "billing/webhook/route.ts": "Stripe webhook — authenticated by Stripe signature, not user session",
};

// Any one of these tokens in a route file counts as 'guards itself'.
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
  const src = readFileSync(file, "utf8");
  const hasSignal = AUTH_SIGNALS.some((s) => src.includes(s));
  const isAllowed = Object.prototype.hasOwnProperty.call(PUBLIC_ALLOWLIST, rel);
  if (!hasSignal && !isAllowed) offenders.push(rel);
}

if (offenders.length) {
  console.error("\n✗ API routes with no auth signal and not on the public allowlist:\n");
  for (const o of offenders) console.error("   • " + o);
  console.error(
    "\nEither add an auth check (getAuthUser / verifyHmac / signature verify),\n" +
      "or, if the route is genuinely public, add it to PUBLIC_ALLOWLIST in\n" +
      "web/scripts/check-route-auth.mjs with a reason and its own abuse mitigation.\n",
  );
  process.exit(1);
}

console.log(`✓ route-auth guard: all API routes guard themselves or are allowlisted (${Object.keys(PUBLIC_ALLOWLIST).length} public).`);

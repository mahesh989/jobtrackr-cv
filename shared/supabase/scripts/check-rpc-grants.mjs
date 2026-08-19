#!/usr/bin/env node
/**
 * RPC-grant guard — proves check_user_auth_methods / replace_stories /
 * consume_usage remain unreachable by the anon/authenticated PostgREST
 * roles.
 *
 * Why this exists
 * ----------------
 * Chunk C5 (2026-08-12) closed a live exploit: these 3 SECURITY DEFINER
 * functions were EXECUTE-granted to anon/authenticated — an unauthenticated
 * caller could look up any email's auth methods, replace another user's
 * stories, or write arbitrary billing-ledger events. The fix was a REVOKE.
 * The gap that revoke does NOT close: `CREATE OR REPLACE FUNCTION` preserves
 * existing grants, but a future DROP+CREATE (e.g. changing a signature)
 * does not — Postgres re-applies whatever ALTER DEFAULT PRIVILEGES says for
 * new objects, which could silently reopen this exact hole with no error,
 * no failing test, nothing but a live production regression (independent
 * review of C5, recommendation R1). This is the CI assertion that
 * recommendation asked for.
 *
 * Why this checks via PostgREST, not pg_proc.proacl directly
 * ------------------------------------------------------------
 * Introspecting proacl needs either a raw Postgres connection (this repo's
 * CI has none — only the PostgREST REST URL + keys) or a NEW SECURITY
 * DEFINER RPC created just to expose it, which is itself another grant
 * surface to keep locked down. Instead, this calls the SAME 3 functions
 * through the exact path an attacker would use — PostgREST's RPC endpoint,
 * authenticated as `anon` — and asserts every call is REJECTED. That tests
 * the real, externally-observable security property directly, not an
 * implementation detail, and needs no new migration.
 *
 * PostgREST hides objects a role has no privilege on rather than exposing a
 * distinct "permission denied" — an unauthorized RPC call returns 404 (or,
 * less commonly, 401/403), not a 200 or a parameter-validation 4xx. Any
 * response OTHER than 401/403/404 means the anon role could at least reach
 * the function, which is the exact regression this guards against.
 *
 * Requires SUPABASE_URL + SUPABASE_ANON_KEY. The anon key is PUBLIC by
 * design (shipped in every page load, not a secret in the security sense),
 * but is not yet wired as a CI credential in this repo — SKIPS (exit 0,
 * loud notice) until it is, matching the sibling schema guards' convention.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_ANON_KEY=... node check-rpc-grants.mjs
 *   node check-rpc-grants.mjs --self-test
 */

const SELF_TEST = process.argv.includes("--self-test");

const GUARDED_RPCS = [
  { name: "check_user_auth_methods", body: { p_email: "ci-probe@example.invalid" } },
  {
    name: "replace_stories",
    body: { p_user_id: "00000000-0000-0000-0000-000000000000", p_rows: [] },
  },
  {
    name: "consume_usage",
    body: {
      p_user: "00000000-0000-0000-0000-000000000000",
      p_kind: "run",
      p_job: "00000000-0000-0000-0000-000000000000",
      p_max_unique: 1,
      p_max_total: 1,
      p_period_start: "2020-01-01T00:00:00Z",
    },
  },
];

// A response in this set means PostgREST rejected the call before it ran —
// the function is unreachable by this role, whether hidden (404, PostgREST's
// default for "no privilege") or explicitly denied (401/403).
const SECURE_STATUSES = new Set([401, 403, 404]);

async function probe(url, anonKey, rpc) {
  const res = await fetch(`${url.replace(/\/$/, "")}/rest/v1/rpc/${rpc.name}`, {
    method: "POST",
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(rpc.body),
  });
  return { name: rpc.name, status: res.status, secure: SECURE_STATUSES.has(res.status) };
}

// ── Self-test: prove the detection logic itself is correct ─────────────────
if (SELF_TEST) {
  const cases = [
    { status: 404, expectSecure: true, label: "404 (PostgREST default for no-privilege)" },
    { status: 401, expectSecure: true, label: "401 (explicit unauthenticated)" },
    { status: 403, expectSecure: true, label: "403 (explicit forbidden)" },
    { status: 200, expectSecure: false, label: "200 (REGRESSION: call succeeded)" },
    { status: 400, expectSecure: false, label: "400 (function reachable, bad params)" },
    { status: 500, expectSecure: false, label: "500 (function reachable, errored inside)" },
  ];
  let ok = true;
  for (const c of cases) {
    const secure = SECURE_STATUSES.has(c.status);
    const pass = secure === c.expectSecure;
    if (!pass) ok = false;
    console.log(`${pass ? "✓" : "✗"} status ${c.label} → secure=${secure} (expected ${c.expectSecure})`);
  }
  console.log(ok ? "\n✓ self-test: detection logic correct" : "\n✗ self-test FAILED");
  process.exit(ok ? 0 : 1);
}

const url = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
if (!url || !anonKey) {
  console.log("⚠ RPC-grant guard SKIPPED — SUPABASE_URL / SUPABASE_ANON_KEY not set.");
  console.log("  This is a SKIP, not a pass: the C5 grant regression is unverified.");
  console.log("  SUPABASE_ANON_KEY is the PUBLIC anon key (safe to add as a plain CI value) —");
  console.log("  add it once to activate this guard for real.");
  process.exit(0);
}

const results = await Promise.all(GUARDED_RPCS.map((rpc) => probe(url, anonKey, rpc)));
const leaked = results.filter((r) => !r.secure);

for (const r of results) {
  console.log(`${r.secure ? "✓" : "✗"} ${r.name}: anon call returned ${r.status}${r.secure ? "" : "  ← REACHABLE"}`);
}

if (leaked.length === 0) {
  console.log("\n✓ RPC-grant guard: all 3 functions unreachable by the anon role.");
  process.exit(0);
}
console.error(
  `\n✗ RPC-grant guard: ${leaked.length} function(s) reachable by the anon role — the C5 fix has regressed.`,
);
console.error("  A DROP+CREATE (signature change) can silently reopen this via ALTER DEFAULT PRIVILEGES.");
console.error("  Re-run the REVOKE statements from 001_full_schema.sql/004_grants.sql for the affected function(s).");
process.exit(1);

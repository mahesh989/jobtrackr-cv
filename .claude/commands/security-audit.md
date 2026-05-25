# /security-audit — Comprehensive, project-agnostic security audit (+ optional fix loop)

A battle-tested security review methodology distilled into a reusable playbook.
It is **stack-agnostic**: it adapts to whatever it finds — web app, REST/GraphQL
API, background worker, mobile backend, CLI, library, monorepo — in any
language. Copy this file into any repo's `.claude/commands/` and run
`/security-audit`.

`$ARGUMENTS` (all optional):
- **Scope** — a subsystem ("the billing module"), a path, "the diff vs main", or
  empty = the whole codebase.
- **Mode** — `audit-only` (report, no edits) or `audit-and-fix` (default: report
  first, then fix in severity order **after** the user approves).

---

## OPERATING PRINCIPLES (non-negotiable — read before touching anything)

1. **Read real code. Never extrapolate from a sample.** The most dangerous
   habit in a security review is reading 10 of 40 handlers, seeing a consistent
   pattern, and declaring the other 30 safe. Class bugs (IDOR, missing authz,
   injection) hide in the *one* handler that breaks the pattern. For any
   whole-class check, **enumerate every instance and read each one.** If you must
   sample for time, say so explicitly and label the rest "not reviewed" — never
   imply coverage you don't have.

2. **Every finding is complete or it isn't a finding.** Each one states:
   *(a)* the vulnerability in one sentence, *(b)* the affected code as
   `path:line`, *(c)* a severity (Critical / High / Medium / Low) with
   justification, *(d)* a concrete proof-of-concept (the request/input that
   exploits it), and *(e)* a fix — a code snippet, not "add validation."

3. **Calibrate severity by real-world impact, not by category.** Cross-tenant
   data read = High/Critical. A verbose error string = Low. A "best practice"
   with no exploit path is an Observation, not a finding. Don't inflate to look
   thorough; don't downplay to look clean. Anchor on: *who* can do *what* to
   *whose* data, and *what they must already have* to do it.

4. **Trust nothing, verify the boundary.** For every trust boundary (client→
   server, service→service, user→tenant, public→authenticated), find the *one*
   place enforcement actually happens and confirm it can't be skipped. A check
   that runs client-side, or in middleware that excludes the route, or after the
   sensitive action, is not enforcement.

5. **Fix safely or don't fix.** A security fix that breaks production is a
   self-inflicted outage. Prefer fail-safe/fail-closed for authz and fail-open
   for availability guards (rate limiting). **Never ship a high-blast-radius
   change you can't test** (e.g. a strict CSP that can break every page) — apply
   the safe subset and flag the rest. Distinguish three fix classes:
   *code-fixable now*, *config/ops-dependent* (needs a dashboard/env change —
   flag, don't fake), and *decision-required* (needs a product/architecture
   call — present options).

6. **Verify every fix.** After each change run the cheapest sound check the repo
   supports — typecheck, lint, compile, unit tests, a build. A fix is not done
   until it's green. Trust-but-verify your own edits: re-read the diff.

7. **Be honest about coverage at the end.** State what you read, what you only
   grepped, and what you didn't touch. A security report's value is destroyed by
   one overclaim.

---

## PHASE 0 — Recon & attack-surface map

Before judging anything, build a model of what can be attacked.

- **Identify the stack & topology.** Languages, frameworks, services
  (frontend / API / worker / db / cache / queue), how they talk, where each is
  deployed, and the **trust boundaries** between them.
- **Enumerate the attack surface** (use `find`/`grep`/glob, not guesswork):
  - Every HTTP entrypoint: routes, handlers, server actions, webhooks, GraphQL
    resolvers, RPC methods.
  - The **auth mechanism**: sessions/JWT/OAuth/API keys/HMAC — and which
    entrypoints it actually covers (watch for middleware that *excludes* a path
    prefix like `/api`).
  - **Data access pattern**: ORM vs raw SQL; is row-level security (RLS)/tenant
    scoping enforced in the DB, or only in app code? Does any code use a
    privileged/service/admin DB client that bypasses RLS? (Every such call site
    must scope by owner manually.)
  - **Secrets**: where keys live, what's encrypted at rest, what's exposed to
    the client bundle (anything `PUBLIC`/`NEXT_PUBLIC`/`VITE_`-prefixed).
  - **Outbound fetches**: anything that fetches a URL the user can influence
    (SSRF surface), incl. scrapers, webhooks, link unfurlers, "import from URL".
  - **Background work**: queues, cron, workers, schedulers — and how jobs are
    enqueued / what data they trust.
  - **File handling**: uploads, downloads, signed URLs, object-storage buckets.
  - **Third-party integrations**: payment, email, AI/LLM, OAuth providers.
- **Name the crown jewels.** PII, credentials/tokens, money/quota, admin
  capability, other tenants' data. Findings that touch these rank highest.
- **Track the work.** For anything beyond a trivial scope, create a task list
  (one per audit domain, plus one per fix) so progress is visible and nothing is
  dropped.

---

## PHASE 1 — The five core audits

Run all five. Adapt each checklist to the detected stack; skip items that
genuinely don't apply and say why.

### 1. Authentication & Authorization
- Broken authentication: missing/skippable token validation, weak session
  management, tokens that are decoded but not verified server-side.
- JWT pitfalls: `alg=none`/algorithm confusion, missing expiry/issuer/audience
  checks, weak/shared secrets, tokens in URLs/logs.
- **Missing authorization on routes** — the big one. For *every* data-accessing
  endpoint: can user A read/modify user B's resource by changing an ID? (IDOR).
  Check that ownership is verified **before** the action, on the *resource*
  itself — not on some other object the attacker also supplies.
- Privilege escalation: can a normal user reach admin actions? Are admin pages
  **and the server actions/APIs behind them** role-gated (not just hidden in
  the UI)?
- Hardcoded credentials / keys in source or history.
- Password storage: must be bcrypt/scrypt/argon2 (or delegated to an IdP) —
  never plaintext/MD5/SHA1.

### 2. Injection & Input Validation (including SSRF)
- SQL/ORM injection (string-built queries, unsafe `raw`/`literal`).
- NoSQL injection (operator injection in document queries).
- Command injection (shell exec with user data — confirm array-arg exec, not a
  shell string; flag `shell=True`/string `exec`).
- XSS: unescaped user data in HTML, `dangerouslySetInnerHTML`/`innerHTML`/
  `v-html`, template autoescaping disabled, `javascript:` URLs.
- Path traversal (`../` in user-controlled file paths/keys).
- **SSRF**: any user-influenced URL that the server fetches. Confirm a guard
  that (a) allowlists scheme, (b) resolves the host and **blocks private /
  loopback / link-local / metadata (169.254.169.254) / unique-local IPs**, and
  (c) re-validates **every redirect hop** (a public URL can 302 to an internal
  one).
- Deserialization of untrusted data; template injection; **format-string
  injection** (untrusted text passed as the *template* to `.format()`/`%`, vs
  safely passed as a *value*).
- Missing length caps / type validation / sane bounds on all user input
  (also a DoS lever).

### 3. API & Data Exposure
- Sensitive fields (password hashes, tokens, secrets, full PII) returned in
  responses when they shouldn't be.
- Missing **rate limiting / brute-force protection** on auth, costly, and
  enumeration-prone endpoints (login, signup, invite/coupon check, anything
  spending money or a 3rd-party quota).
- Overly permissive **CORS** (wildcard origin with credentials).
- Internal error/stack-trace leakage to clients (log server-side, return
  generic).
- Missing pagination → mass extraction.
- Unauthenticated endpoints that should require auth.
- HTTP security headers: CSP, HSTS, X-Frame-Options/`frame-ancestors`,
  X-Content-Type-Options, Referrer-Policy, Permissions-Policy.
- Secrets excluded from client bundles.

### 4. Dependencies & Configuration
- Outdated packages with known CVEs (cross-ref lockfiles; run `npm audit` /
  `pip-audit` / `osv-scanner` / `govulncheck` if available — if offline, say so
  and list versions to check).
- Deprecated/unmaintained/typosquatted packages.
- Dev dependencies bundled into production.
- `.env`/secret files committed (check the repo **and** history); correct
  `NODE_ENV`/prod flags; debug endpoints/docs disabled in prod.
- Least privilege: over-broad IAM roles, DB grants, bucket ACLs, service
  accounts.
- Dangerous dynamic execution: `eval`, `Function`, `vm`, dynamic `require`.
- Process running as root / unnecessary OS privileges.

### 5. Business Logic & State
- Client-trusted values the server must re-check: prices, quantities, totals,
  roles, IDs, feature flags.
- Race conditions / idempotency on money & critical writes (double-spend,
  duplicate submit, double-send). Look for check-then-act gaps; prefer atomic
  conditional updates / unique constraints.
- Workflow bypass: skipping payment, email verification, an approval step, or an
  **invite/eligibility gate** (especially gates enforced only client-side).
- File uploads validated by **content (magic bytes) + size**, not just
  extension/declared MIME.
- Sensitive logic that lives client-side but should be server-authoritative.
- IDOR (cross-reference with audit 1 — enumerate *every* object-by-id handler).
- Audit logging for sensitive actions (login, deletion, permission/role change,
  data export, payment).

---

## PHASE 2 — Deep dig (the second pass that catches what the first misses)

The five audits cover the obvious surface. Real review goes one layer deeper.
These are the places experienced attackers look and reviewers skip:

- **Object storage / buckets.** Are buckets private? Is there object-level ACL/
  RLS scoping each file to its owner? A public bucket + guessable path is a data
  breach independent of any app-layer IDOR. (Also: storage MIME/size limits only
  check the *declared* content-type — still validate bytes server-side.)
- **Background workers / queues / cron.** What data do jobs trust? Can a user
  enqueue arbitrary work or inject into a cron/schedule string? Is one tenant's
  failing job isolated from others (no shared-loop crash)? Do workers fetch
  user-influenced URLs without an SSRF guard?
- **Full auth lifecycle**, not just login: signup gating (server-side?),
  open-redirect in callbacks (`next`/`redirect` params), OAuth `state`/PKCE/CSRF,
  password-reset token strength & reuse, email change, session fixation/rotation,
  account-deletion completeness (DB rows **and** storage objects **and** 3rd-party
  tokens).
- **AI / LLM features** (increasingly common): BYOK key handling (in-memory only,
  never logged/persisted), **SSRF via a user-supplied `base_url`/endpoint**,
  provider/model allowlisting, **prompt-template injection**, and never feeding
  model output into an executor (SQL/shell/`eval`). Prompt injection that only
  affects the user's own output is informational; flag where it crosses a
  boundary.
- **Multi-tenant isolation, exhaustively.** Re-list every handler that reads or
  writes tenant data and confirm each scopes by the authenticated principal —
  not by an ID from the request, and not by relying on a privileged client that
  bypasses RLS without a manual check.
- **Framework-specific footguns** for whatever you detected, e.g.: Next.js
  middleware matcher gaps & server-action authz; Express/Flask trusting
  `X-Forwarded-*`; Spring/Rails mass-assignment; Django `DEBUG`/`SECRET_KEY`;
  GraphQL introspection/depth/batching; Supabase/Firebase **RLS as the only
  backstop when app code uses the service role.**
- **Git history** for committed secrets even if the working tree is clean.

---

## PHASE 3 — Report

Present findings grouped by the five audits (plus a "Deep dig" section). Lead
with a one-line severity tally. For each finding use:

> **[SEVERITY] Title** — `path:line`
> *What it is.* One or two sentences.
> *PoC.* The exact request/input/sequence that exploits it.
> *Fix.* A minimal code snippet.

Then a **scorecard table** (finding → severity → status) and an explicit
**coverage statement**: what was read in full, what was only grepped, what was
out of scope. Include a short "verified clean" list so the reader knows which
high-value areas you checked and cleared — that is as valuable as the findings.

---

## PHASE 4 — Fix loop (only if mode is `audit-and-fix` and the user approved)

1. Create one task per fix; work **in severity order** (Critical → High → …).
2. Fix **one finding at a time**, then **verify** (typecheck/lint/compile/test)
   before the next. Re-read each diff.
3. Apply the **safe-fix doctrine** from Principle 5:
   - Authz/IDOR/SSRF: fail closed.
   - Rate limiting / availability guards: fail open.
   - Don't ship untested high-blast-radius config (e.g. a content-restricting
     CSP) — apply the safe subset, document the rest as a follow-up.
   - For config/ops-dependent fixes, implement the code side and **clearly flag
     the required dashboard/env change** — never imply a gate is enforcing when
     it depends on a setting only the owner can flip.
4. Keep a running tally. At the end, produce: the cumulative fix table, residual
   risks (with why-not-fixed), and an explicit **owner action list**
   (config changes, dependency bumps, scanner runs, decisions).

---

## CLOSING CHECKLIST
- [ ] All five core audits done; deep-dig pass done.
- [ ] Every whole-class check (IDOR/authz/injection) enumerated, not sampled.
- [ ] Every finding has severity + `path:line` + PoC + fix.
- [ ] Every applied fix verified green.
- [ ] Coverage stated honestly; residuals and owner-actions listed.
- [ ] No secret, no untested high-blast-radius change, shipped.

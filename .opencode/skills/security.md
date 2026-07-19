---
name: security
description: "Handle security-sensitive areas in JobTrackr-CV. Covers IDOR, rate limiting, double submission, CSRF, XSS, SSRF, race conditions, timing attacks, auth guards, and all OWASP-top-10 concerns. Use when working on any security-sensitive code."
trigger: always
---

# Security Patterns

## Threat Model

This is a multi-tenant SaaS where users can supply arbitrary URLs, upload files, and trigger AI-powered processing. The attack surface includes:

- User-supplied URLs (SSRF vector)
- File uploads (malicious content)
- AI API key handling (credential theft)
- Multi-user data isolation (IDOR)
- Billing manipulation (entitlement bypass)
- Concurrent operations (race conditions)

## 1. IDOR (Insecure Direct Object References)

**Protection: Defence-in-depth — ownership check at EVERY endpoint + RLS + CI guard.**

### Pattern: Admin client ownership verification

When using the admin Supabase client (which bypasses RLS), you MUST manually verify ownership:

```typescript
// 1. Authenticate
const { user, error: authErr } = await requireUser();
if (authErr) return authErr;

// 2. Fetch resource with admin client (bypasses RLS)
const admin = createAdminClient();
const { data: job } = await admin
  .from("jobs").select("id, profile_id").eq("id", jobId).maybeSingle();

// 3. Verify ownership through join
const { data: profile } = await admin
  .from("search_profiles").select("user_id").eq("id", job?.profile_id).maybeSingle();

if (profile?.user_id !== user.id) {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

// 4. Safe to mutate
```

### Pattern: Direct user_id scoping

For simpler queries, scope directly by user_id:

```typescript
const { data } = await supabase
  .from("cv_versions")
  .select("*")
  .eq("user_id", user.id)  // Direct ownership filter
  .eq("id", cvId);
```

### CI enforcement

`frontend/web/scripts/check-route-auth.mjs` runs in CI on every push. It walks every `route.ts` and fails the build if any route lacks both auth-acquisition AND enforcement signals. Only 3 routes are allowlisted as public: `billing/webhook`, `auth/forgot-password`, `notifications/unsubscribe`.

**When adding a new API route, the CI script will reject it if you forget auth.**

### All protected endpoints (non-exhaustive)

| Endpoint | Verification |
|----------|-------------|
| `cv/[id]` GET/PATCH/DELETE | `.eq("user_id", user.id)` |
| `applications/[letter_id]` | `letter.user_id !== user.id` |
| `applications/[letter_id]/email-draft` | `letter.user_id !== user.id` |
| `jobs/[id]/analyze` | `profile.user_id !== user.id` |
| `jobs/[id]/cover-letter` | `profile.user_id !== user.id` |
| `jobs/[id]/cover-letter/[letter_id]/download` | `profile.user_id !== user.id` |
| `jobs/[id]/cover-letter/[letter_id]/pick` | `letter.user_id !== user.id` |
| `profiles/[id]/runs` | Explicit ownership check |
| `user/stories/[id]` | `existing.user_id !== user.id` |
| `user/stories/match` | `profile.user_id !== user.id` |
| `company-research/facts/select` | `profile.user_id !== user.id` (documented: "Service-role bypasses RLS so manual check required") |

## 2. Rate Limiting

**Implementation:** `lib/rateLimit.ts` — Fixed-window INCR + EXPIRE on Upstash Redis. **Fail-open** (if Redis is down, requests pass).

### All rate-limited endpoints

| Endpoint | Key | Limit | Window |
|----------|-----|-------|--------|
| `POST /api/cv` (upload) | `cv-upload:{userId}` | 5 | 60s |
| `POST /api/jobs/[id]/analyze` | `analyze:{userId}` | 20 | 60s |
| `POST /api/jobs/[id]/analyze/[run_id]/resume` | `analyze:{userId}` | 20 | 60s |
| `POST /api/jobs/[id]/cover-letter` | `cover-letter:{userId}` | 20 | 60s |
| `POST /api/profiles/[id]/run` | `run:{userId}` | 10 | 60s |
| `POST /api/jobs/scrape-url` | `scrape-url:{userId}` | 10 | 60s |
| `POST /api/cv/[id]/extract-references` | `cv-extract-references:{userId}` | 10 | 60s |
| `POST /api/cv/[id]/extract-skills` | `cv-extract-skills:{userId}` | 12 | 60s |
| `POST /api/cv/[id]/structurize` | `cv-structurize:{userId}` | 8 | 60s |
| `POST /api/auth/forgot-password` | `forgot-password:{ip}` | 10 | 60s |
| `GET /api/notifications/unsubscribe` | `unsub:{uid}` | 10 | 60s |
| `POST /api/admin/ai-settings` | `admin-ai-settings:{userId}` | 20 | 60s |

Note: `forgot-password` is rate-limited by IP (not user ID) — correct for unauthenticated endpoints.

### Adding rate limiting to a new endpoint

```typescript
import { rateLimit, RATE_LIMIT_MESSAGE } from "@/lib/rateLimit";

export async function POST(req: Request) {
  const { user, error: authErr } = await requireUser();
  if (authErr) return authErr;

  const rl = await rateLimit(`my-endpoint:${user.id}`, 10, 60);
  if (!rl.allowed) {
    return NextResponse.json({ error: RATE_LIMIT_MESSAGE }, { status: 429 });
  }
  // ... handler logic
}
```

## 3. Double Submission / Multiple Clicks

**Protection: UI disabling + server-side idempotency guards.**

### UI pattern

Every mutation button uses `useTransition` + `isLoading` + `disabled`:

```tsx
const [pending, startTransition] = useTransition();

<Button
  isLoading={pending}
  onClick={() => startTransition(async () => {
    await someAction(jobId);
    router.refresh();
  })}
>
  Save
</Button>
```

The `Button` component (`components/ui/Button.tsx`) passes `isLoading` as `disabled` on the underlying `<button>`, preventing double-clicks.

### Server-side idempotency

| Location | Pattern |
|----------|---------|
| CV upload (`api/cv/route.ts`) | Rejects duplicate POSTs for same `cv_id` (409 Conflict) |
| Profile duplication (`lib/actions/profiles.ts`) | 10-second time-window dedup guard |
| Tailored CV PDF (`api/applications/[letter_id]/tailored-cv-pdf/route.ts`) | PUT = idempotent upsert |
| Worker notifications (`gate.ts`) | Claim-based idempotency |
| Billing webhook (`billing/webhook/route.ts`) | Unique constraint on `stripe_events.event_id` |

### When adding a new mutation

1. Add `useTransition` + `isLoading` on the client
2. Consider adding a server-side idempotency guard if the action is expensive or non-reversible
3. Use `router.refresh()` after mutation to sync server state

## 4. CSRF (Cross-Site Request Forgery)

**Status: Partially protected — low risk due to architecture.**

### What's protected

- OAuth state tokens verified in callbacks (`api/auth/email/google/callback/route.ts`)
- Stripe webhook signature verified (`billing/webhook/route.ts`)
- Admin view-as cookie set with `httpOnly: true, sameSite: "lax"`
- Backend/api uses HMAC-signed requests (not cookie-based) — CSRF irrelevant

### What's not present

- No global CSRF token middleware on Next.js API routes
- No explicit `SameSite` attribute on Supabase auth cookies in middleware

### Why it's low risk

1. Internal API routes (cv-backend) are HMAC-signed, not cookie-authenticated
2. Supabase session cookies default to `SameSite=Lax`
3. The only non-cookie auth mechanism (Stripe webhook) has its own signature check

### When adding new endpoints

- Use `SameSite: "lax"` on any cookies you set
- For state-changing operations triggered by form submissions, the `SameSite=Lax` default provides protection
- For API routes called from JavaScript, consider requiring a custom header (which cross-origin requests can't set)

## 5. XSS (Cross-Site Scripting)

**Status: Low risk — all `dangerouslySetInnerHTML` usage is on static/escaped data.**

### All `dangerouslySetInnerHTML` instances

| File | Content | Risk |
|------|---------|------|
| `app/layout.tsx` | Static FOUC prevention script | None — no user data |
| `app/page.tsx` | `JSON.stringify(JSON_LD)` | None — hardcoded object, stringify escapes HTML |
| `lib/cvPdfRender.tsx` | Static CSS constant | None — no user data |
| `lib/cvMarkdownHelpers.ts` | PDF rendering (server-side) | None — server-side only, user authored their own CV |

### Why no DOMPurify

The codebase doesn't use DOMPurify because user content is never injected into browser HTML via `innerHTML`. The `innerHTML` usage is confined to PDF rendering utilities that run in a controlled context.

### When adding new features

- **Never** use `dangerouslySetInnerHTML` with user-controlled content
- If you must render user HTML, use a sanitizer (DOMPurify or similar)
- React's default JSX escaping handles most cases automatically
- Markdown rendering uses `react-markdown` which sanitizes by default

## 6. SQL Injection / Supabase Injection

**Status: Fully protected — zero raw SQL in application code.**

All database access uses the Supabase PostgREST client which parameterizes queries:

```typescript
// GOOD — parameterized
const { data } = await supabase.from("jobs").select("*").eq("id", jobId);

// NEVER — string interpolation in queries
const { data } = await supabase.rpc("query", { sql: `SELECT * FROM jobs WHERE id = '${jobId}'` });
```

**Never construct raw SQL queries in application code.** The only SQL exists in migration files.

## 7. Race Conditions

**Status: Addressed with idempotency guards and unique constraints.**

### Known race conditions

| Location | Mitigation |
|----------|-----------|
| CV activation (deactivate + activate) | Partial unique index on `(user_id) WHERE is_active = true` |
| Worker notifications | Claim-based idempotency ("concurrent run can't double-claim") |
| Billing webhook | Unique constraint on `stripe_events.event_id` |
| Profile duplication | 10-second time-window dedup guard |
| Worker lock management | Stale lock auto-expiry on startup |

### When adding new concurrent operations

1. Use database unique constraints as the safety net
2. Add idempotency guards (time-window dedup, claim-based, or unique constraints)
3. Document the known race condition in comments
4. Consider using `SELECT ... FOR UPDATE` if strict ordering is required

## 8. Information Leakage

**Status: Well controlled — generic errors in production, stack traces server-side only.**

### Backend API error handler

```python
@app.exception_handler(Exception)
async def unhandled_exception_handler(request, exc):
    logger.exception("Unhandled exception on %s %s", ...)  # Server logs only
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error", "request_id": get_request_id()},
    )
```

- Generic message to client
- Stack trace to server logs + Sentry
- `send_default_pii=False` on Sentry

### Frontend API routes

- Return generic errors: `{ error: "Unauthorized" }`, `{ error: "Not found" }`
- DB error details logged server-side, not returned to clients

### When adding error handling

```typescript
// GOOD — generic message to client
try {
  // ... operation
} catch (e) {
  console.error("Operation failed:", e);  // Server log
  return NextResponse.json({ error: "Operation failed" }, { status: 500 });
}

// BAD — leaks internal details
catch (e) {
  return NextResponse.json({ error: `DB error: ${e.message}` }, { status: 500 });
}
```

## 9. Authentication Bypass Prevention

**Protection: Three layers — middleware + per-route checks + CI guard.**

### Layer 1: Middleware

`middleware.ts` redirects unauthenticated users to `/auth/login` for all non-public routes. API routes are deliberately NOT middleware-gated — each checks auth itself.

### Layer 2: Per-route guards

Every API route uses either:
- `requireUser()` from `lib/api-utils.ts` — returns `{ user, error }` or
- Manual `supabase.auth.getUser()` check

### Layer 3: CI guard script

`frontend/web/scripts/check-route-auth.mjs` fails the build if any route lacks auth.

**Only 3 routes are intentionally public:**
1. `billing/webhook` — Stripe signature verification
2. `auth/forgot-password` — rate-limited by IP
3. `notifications/unsubscribe` — rate-limited by UID

### When adding a new API route

```typescript
// The CI script will reject this if you forget auth:
export async function POST(req: Request) {
  const { user, error: authErr } = await requireUser();  // REQUIRED
  if (authErr) return authErr;
  // ... handler
}
```

## 10. Authorization

### Admin access

Two guard implementations (both correct):

```typescript
// API routes
const { user, error: authErr } = await requireUser();
if (authErr) return authErr;
const { admin, error: adminErr } = await requireAdmin(user!);
if (adminErr) return adminErr;  // 403 Forbidden

// Server components
const { admin } = await requireAdmin();  // Redirects to / if not admin
```

Admin roles: `["founder", "admin"]` (from `lib/constants.ts`).

### Billing entitlements

```typescript
// Admin/founder bypass all billing checks
const role = (userRow as { role?: string } | null)?.role ?? "beta";
if ((ADMIN_ROLES as readonly string[]).includes(role)) {
  return { allowed: true };  // Unlimited access
}
```

## 11. Input Validation

### Backend (Pydantic)

```python
class AnalyzeRequest(BYOK):
    run_id: uuid.UUID
    user_id: str
    cv_version_id: str
    jd_text: str = Field(min_length=1)
    min_initial_ats: float = 50.0
```

### Frontend (manual)

```typescript
// UUID validation
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
  return NextResponse.json({ error: "Invalid ID" }, { status: 400 });
}

// File extension whitelist
const ALLOWED_EXT = new Set(["pdf", "docx"]);
if (!ALLOWED_EXT.has(ext)) {
  return NextResponse.json({ error: "Invalid file type" }, { status: 400 });
}

// String length bounds
if (body.length < 50 || body.length > 20_000) {
  return NextResponse.json({ error: "Invalid length" }, { status: 400 });
}
```

**No Zod/Yup/Joi in frontend** — validation is manual but present.

## 12. File Upload Security

### Flow (client-side upload)

1. Browser mints signed upload URL from `/api/cv/upload-url`
2. Browser uploads file directly to Supabase Storage (server never sees bytes)
3. Browser POSTs JSON summary to `/api/cv` for finalization

### Protections

| Protection | Implementation |
|-----------|----------------|
| Extension whitelist | `ALLOWED_EXT = new Set(["pdf", "docx"])` |
| Path ownership | `storage_path` must start with `${user.id}/${cv_id}.` |
| Storage RLS | `auth.uid() == first path segment` |
| Existence verification | Confirms file exists in Storage before creating DB row |
| No server body | Vercel function body limit avoided by design |

## 13. SSRF (Server-Side Request Forgery)

### Backend: Protected

`backend/api/app/security/ssrf.py`:

```python
from app.security.ssrf import assert_public_url, safe_get

# Validates URL resolves to public IP
assert_public_url(user_provided_url)

# Safe GET with SSRF validation on every redirect hop
response = await safe_get(client, url)
```

Covers: private IPs, loopback, link-local, IPv4-mapped IPv6. Known residual risk: DNS rebinding.

### Frontend: KNOWN GAP

`/api/jobs/scrape-url` calls `scrapeJobUrl(url)` with a user-supplied URL. **No SSRF validation** on the URL before fetching. Rate-limited (10/60s) which bounds abuse volume, but a user could point the scraper at `http://169.254.169.254/latest/meta-data/` or internal services.

**When adding any endpoint that fetches user-supplied URLs, always add SSRF validation:**

```typescript
import { assert_public_url } from "@/lib/ssrf";  // If available

// Or replicate the validation:
import dns from "dns";
import net from "net";

async function validateUrl(url: string): Promise<boolean> {
  const parsed = new URL(url);
  const hostname = parsed.hostname;
  const addrs = await dns.promises.resolve4(hostname);
  for (const addr of addrs) {
    if (net.isPrivate(addr) || net.isLoopback(addr)) return false;
  }
  return true;
}
```

## 14. Timing Attacks

**Protected — constant-time comparison everywhere.**

| Location | Implementation |
|----------|---------------|
| HMAC verification (`hmac.py`) | `hmac.compare_digest(expected, sig_header)` |
| Unsubscribe link (`unsubscribe/route.ts`) | `crypto.timingSafeEqual(expectedBuf, gotBuf)` |
| Stripe webhook | Stripe SDK handles internally |

**Never use `===` for signature/token comparison.** Always use `timingSafeEqual` or `compare_digest`.

## 15. HMAC-Signed Internal API

All frontend/worker → backend/api communication uses HMAC-SHA256:

```typescript
// Frontend: lib/cvBackend.ts handles signing automatically
const result = await callCvBackend<ResponseType>("/internal/analyze", body);

// Signing: X-Timestamp (unix seconds) + body → HMAC-SHA256 → X-Signature
```

```python
# Backend: verify_hmac dependency on all /internal routes
router = APIRouter(prefix="/internal", dependencies=[Depends(verify_hmac)])

# Verification: 300s replay window, constant-time compare
```

**Never expose backend/api routes to the browser.** They accept only HMAC-signed requests.

## 16. API Key Encryption

AES-256-GCM for stored API keys:

```typescript
import { encryptApiKey, decryptApiKey } from "@/lib/integrations/crypto";

// Encrypt on save
const encrypted = encryptApiKey(plainTextApiKey);

// Decrypt on use (in-memory only, never persisted)
const plainKey = decryptApiKey(encryptedFromDb);
```

Format: `base64(iv[16] | authTag[16] | ciphertext)`. Key from `INTEGRATION_ENCRYPTION_KEY` env var.

AI pipeline holds keys in memory for pipeline lifetime only — never persisted to DB.

## Environment Variables (Security-Relevant)

| Variable | Purpose | Where |
|----------|---------|-------|
| `SUPABASE_SERVICE_ROLE_KEY` | Admin access (bypasses RLS) | backend/api, frontend, worker |
| `JOBTRACKR_HMAC_SECRET` | HMAC signing shared secret | backend/api, frontend |
| `INTEGRATION_ENCRYPTION_KEY` | AES-256-GCM master key | frontend, worker |
| `STRIPE_SECRET_KEY` | Stripe billing | frontend |
| `SENTRY_DSN` | Error tracking | backend/api |

**Never commit these to git.** They're in `.env` files (gitignored).

## Security Headers

```typescript
// next.config.ts
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
];
```

## Anti-Patterns

| Anti-Pattern | Why | Correct Approach |
|-------------|-----|------------------|
| Skip ownership verification with admin client | IDOR vulnerability | Always check `user_id !== user.id` |
| Use `===` for signature comparison | Timing attack | Use `timingSafeEqual` or `compare_digest` |
| Fetch user URLs without SSRF validation | SSRF vulnerability | Validate URL resolves to public IP |
| Log `voice_sample_text` or API keys | Information leakage | Never log sensitive fields |
| Skip rate limiting on mutation endpoints | Abuse vector | Rate limit all state-changing endpoints |
| Return raw DB errors to client | Information leakage | Return generic messages, log details server-side |
| Use `dangerouslySetInnerHTML` with user data | XSS | Use React sanitization or DOMPurify |
| Disable RLS without justification | Data isolation failure | Every table must have RLS policies |
| Use service-role key in client code | Credential exposure | Server-side only |
| Hardcode secrets in source code | Credential exposure | Use environment variables |

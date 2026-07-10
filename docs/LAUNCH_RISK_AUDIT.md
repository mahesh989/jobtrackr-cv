# JobTrackr-CV — Launch Risk Audit

> Written from `docs/ARCHITECTURE_MAP.md`, `docs/CONTRACTS.md`, and `.claude/graph.json`
> (2026-07-08). Scope: what breaks, embarrasses, or costs money once 10-50 paying
> strangers depend on this. Not a request for a perfect system — a request to launch
> safely.

## Correction to your framing before anything else

Your question assumes **BYOK AI keys (AES-256-GCM)** are still the model. They aren't.
**D20 (2026-06-16) removed BYOK for AI entirely.** There is now one platform-wide AI
key (Anthropic/OpenAI/DeepSeek), admin-managed in `platform_ai_settings`, used for
every user's analysis. **AI cost is now yours, not the user's.** AES-256-GCM still
protects the *other* per-user secrets that remain in `user_integrations` (Apify token,
email OAuth) — just not AI keys anymore. This changes the shape of the cost-blowup
risk: it's no longer "a user leaks their own key," it's "a user (or a bug) burns
your shared key's spend," and it's the reason billing caps matter more than they would
under the old model.

Overall read: **you're closer to ready than the question implies.** The billing meter
(`consume_usage()` — atomic reserve/commit/void, `FOR UPDATE` row lock, 1h TTL
self-heal) is a genuinely solid design, app-layer authz was reviewed and found GOOD
(50/53 routes guard auth, IDOR-safe ownership checks), and Turnstile is live on
signup/login. The real blockers below are small, mostly config-and-verification, not
rewrites.

---

## 1. Ranked risks

| # | Risk | Concrete failure | Cheapest mitigation |
|---|---|---|---|
| 1 | Billing never exercised with real money, esp. webhook idempotency + the full trial→paid→cancel→dunning path | Stripe's at-least-once webhook retries could double-process an event; a failed-payment or cancel edge case leaves a user mis-entitled (charged but locked out, or not charged but still unlimited) | Run one full Stripe **test-mode** lifecycle before flipping to live keys: checkout → trial-convert → upgrade → failed card → cancel → resubscribe. No code needed if it passes. |
| 2 | Worker + API deploys are **manual** and the changelog shows a recurring pattern of "PENDING: apply migration / flyctl deploy" items that may still be outstanding — including migration 069 (`sync_usage_from_analysis_run`), which is billing-correctness code (voids a CV-credit reservation when a run is gate-skipped) | If 069 isn't applied in Supabase, a gate-skipped run (no CV produced) still **docks the user's quota** — you charge someone for nothing delivered | Read-only check in Supabase SQL editor: confirm migration 069 is applied and `flyctl deploy` both `backend/worker` and `backend/api` from current `main` so deployed code matches what you think shipped. |
| 3 | Upstash Redis password was found leaked into git history during the 2026-06-11 review; no record it was rotated since | Anyone with that old password can reach your BullMQ queue — inject/poison jobs into the **shared** job bucket (`global_jobs`, read by every user) or DoS the worker | Rotate the Upstash password in the Upstash dashboard, update the Fly secret on `jobtrackr-worker`. Five minutes, zero code. |
| 4 | Docs state "20 of 21 core tables have RLS enabled" — the 1 exception isn't named anywhere in the map/contracts | If that table holds per-user data (not a genuinely public/service-role-only table), it's a direct cross-user data leak | `select tablename from pg_tables where schemaname='public' and rowsecurity=false;` against the 21 core tables. Almost certainly fine (likely `platform_sources`/similar admin-only table) — just confirm it, don't guess. |
| 5 | No edge rate limiting on AI-spend routes specifically — `lib/rateLimit.ts` covers 11 routes, but the map doesn't confirm `analyze`/`cover-letter`/`cv upload` are among them | A compromised or careless authenticated account could hammer AI endpoints in a tight loop; **billing caps bound the dollar damage per account**, but not the noise/API-latency impact on you | Add Upstash Ratelimit (you already run Upstash) to the AI-calling routes specifically. Not urgent — the blast radius is already capped by `consume_usage()`. |
| 6 | `backend/api` (cv-backend) has no described crash/OOM alerting — `CONTRACTS.md` §3 documents this in detail for the **worker only** (Redis "expected shutdown" marker + deduped email alert); nothing analogous is described for api | If cv-backend OOMs or crash-loops, Fly's default `on-failure` restart brings it back, but you may not find out until a user reports tailoring/PDF/cover-letters are down | Turn on Fly's built-in health-check alerting for `jobtrackr-cv-api` (dashboard setting) as a stopgap; port the worker's restart-marker pattern later if it recurs. |
| 7 | Apify cost leak: `loadApifyIntegration()` falls back to **any founder/admin Apify integration** when a profile's own owner has none — spend lands on the admin's account, not the user's | A batch of users without their own Apify token could quietly run up spend on your (the admin's) Apify quota with no per-user cap on that path | Watch the Apify billing dashboard for the first few weeks; this is already gated to unlimited-tier-only for most sources, so exposure is bounded. |
| 8 | Billing entitlement logic is **duplicated by hand** between `frontend/web/src/lib/billing/{entitlements,plans}.ts` and `backend/worker/src/automation/billing.ts` ("keep in sync" — no shared code, by design, see CONTRACTS §4) | A future plan-cap change updated in one place and forgotten in the other silently lets auto-analyze bypass a cap the manual path enforces (or vice versa) | No fix needed now — just remember to touch both files together next time plan caps change. Not urgent, name it here so it isn't lost. |
| 9 | Pricing hierarchy: Weekly (A$9.99/wk, uncapped) sits at a similar-or-lower price than Unlimited (A$29.99/mo) for the same effective access | Not a technical risk — a revenue-model gap. Rational users pick Weekly and get Unlimited-equivalent access cheaper | Business decision, not code. Revisit pricing before a real marketing push, not before launch. |

---

## 2. Three tiers

### LAUNCH BLOCKER — fix before the first paying user

Keeping this list honest and short: every item here is either "wrong charge," "cross-user
data leak," or "queue poisoning that affects every user," and every fix is cheap.

1. **Run one full Stripe test-mode lifecycle** (trial → convert → upgrade → failed
   card → cancel → resubscribe) before switching to live keys.
   — *Type: a decision/action you do yourself, no coding session needed.*
2. **Confirm migration 069 (billing gate-skip void) is applied in Supabase, and
   `flyctl deploy` both `backend/worker` and `backend/api` from current `main`** so
   deployed behavior matches the code you think shipped.
   — *Type: config/dashboard action (Supabase SQL editor read + two `flyctl deploy`
   commands).*
3. **Rotate the Upstash Redis password** leaked into git history on 2026-06-11 (no
   record it's been rotated since).
   — *Type: config/dashboard action (Upstash dashboard + one Fly secret update).*
4. **Identify the 1 of 21 core tables without RLS and confirm it holds no per-user
   data** (or add a policy if it does).
   — *Type: a quick Sonnet session or a single SQL query against Supabase; likely a
   non-event, but unverified today.*

### FIX SOON — launch is fine, close these in the first few weeks

- Add rate limiting on the AI-spend routes specifically (`analyze`, `cover-letter`,
  `cv` upload/extract) if they aren't already in `lib/rateLimit.ts`'s 11 covered
  routes — bounded financially already by billing caps, this is about noise/latency,
  not a surprise bill.
- Turn on Fly platform-level crash/health alerting for `jobtrackr-cv-api` (the worker
  has bespoke alerting; the api tier doesn't, per CONTRACTS §3's scope).
- Watch the Apify billing dashboard weekly for the first month — the admin-fallback
  path (item 7 above) has no per-user cap of its own.
- Establish a habit (or CI trigger) for deploying worker/api promptly after merging to
  `main` — the manual-deploy lag is a recurring, named pain point in your own build
  log, not a one-time catch-up.
- Revisit the Weekly-vs-Unlimited pricing gap before any real marketing spend.

### ACCEPT / LATER — real, but not worth solving at 10-50 users

- **512MB / `concurrency: 1` worker ceiling.** Already the reason Jora is disabled;
  documented and deliberately not "fixed" by a service split. *Trigger to revisit:*
  re-enabling a Playwright-based source, or raising `concurrency` (must raise memory
  in lockstep — see CONTRACTS §5).
- **Single always-warm `backend/api` machine, no redundancy.** Fly's default
  `on-failure` restart covers ordinary crashes; the only structurally unsolved case is
  crash-loop-before-first-boot (a Fly-platform limitation, not fixable in-app anyway).
  *Trigger:* a customer-visible outage actually happens more than rarely, or user count
  exceeds ~50.
- **No shared runtime code across the three services.** Deliberate — a future service
  split would carry zero untangling cost. Do not "fix" this by introducing a shared
  package for convenience.
- **Manual, hand-numbered SQL migrations with no CI drift gate** (one historical
  duplicate-number incident on 027, already grandfathered). A migration runner + CI
  gate is planned but not urgent at this scale. *Trigger:* a second numbering
  collision, or a bad migration actually reaching production data.
- **Dormant `global_jobs`/`profile_jobs` bucket architecture** (flag-gated off by
  default) and the paused aged-care ATS adapters (Dayforce/PageUp/ScoutTalent/Avature)
  — feature-completeness items, not launch risks; they're inert until you turn them on.
- **Dangling "pending" usage reservations self-heal after a 1h TTL.** A crashed run
  can leave a user's quota looking "stuck" for up to an hour. Acceptable; just know
  it if a user reports a phantom quota hit.

---

## 3. What this audit deliberately did not chase

- General SaaS advice not specific to this system (backups strategy, GDPR, SOC2, etc.)
  — none of it was flagged as load-bearing by the map/contracts, so it's omitted per
  your instruction not to pad.
- The five paused aged-care source adapters, the dormant global-bucket rollout, and
  the refactor/architecture-review branch's unmerged repo-hygiene work — these are
  roadmap items, not launch risks, since they're either inert (flag-off) or simply
  unmerged.

# Spec — Isolate non-production from production Redis state

**Status:** proposed, not implemented
**Author:** drafted 2026-08-01
**Related:** `fix/careerjet-error-visibility` (health-tracker namespacing, already merged into that branch)

---

## 1. Problem

One Upstash Redis instance is shared by every environment. `backend/worker/.env.example`
and `frontend/web/.env.example` both hand developers a single `REDIS_URL`, and there is no
separate dev instance documented anywhere.

The queue name is a hardcoded constant in three places across two apps:

| File | Line |
|---|---|
| `backend/worker/src/queue/connection.ts` | 11 |
| `frontend/web/src/app/api/profiles/[id]/run/route.ts` | 8 |
| `frontend/web/src/lib/actions/_helpers.ts` | 13 |

`backend/worker/src/index.ts:38` opens a BullMQ `Worker` on that name. So **a developer
running `npm run dev` in `backend/worker` becomes a live consumer of the production
queue.** BullMQ hands each job to exactly one consumer, so the dev machine will win jobs
at random and execute real users' pipeline runs locally: scraping under the dev machine's
IP, spending the configured AI budget, and writing results to production Supabase.

The reverse leak also exists but is milder — a local or preview frontend enqueues into the
production queue, and the production worker executes it.

This is the same class of bug as the Careerjet health-counter issue, which is already
fixed. This spec covers the rest.

### Why this cannot be fixed in one app

Changing `QUEUE_NAME` in the worker alone **breaks production outright**: the frontend
would keep enqueueing to `jobtrackr-pipeline` while the worker listened elsewhere, so
every run would silently pile up unprocessed. Producer and consumer must move together.

---

## 2. Inventory of shared state

| Key / namespace | Owner | Risk if shared | Status |
|---|---|---|---|
| `jobtrackr-pipeline` (BullMQ → `bull:jobtrackr-pipeline:*`) | worker (consumer), frontend (producer) | **Critical** — dev executes production runs | ❌ open |
| `jobtrackr:health:*` | worker | Dev failures block prod sources for 7d | ✅ fixed |
| `rl:*` (`frontend/web/src/lib/rateLimit.ts:41`) | frontend | Preview/local traffic drains production users' rate-limit budget. Fail-open, so degraded not broken | ❌ open |
| `jobtrackr:alert:sent:*` (`errorAlert.ts:12`) | worker | Dev run can suppress a production alert via dedup, or fire a spurious one | ❌ open |
| `jobtrackr:worker:expected_shutdown` (`index.ts:21`) | worker | Dev boot can consume prod's marker → missed or false crash alert | ❌ open |
| `worker:heartbeat:<machineId>` (`heartbeat.ts:14`) | worker | Keyed by machine ID, so effectively isolated; a dev heartbeat would still show up in any "who's alive" listing | ⚠️ cosmetic |

---

## 3. Design

### 3.1 Namespace source

The worker (Fly) and frontend (Vercel) run on different platforms, so neither
`FLY_APP_NAME` nor `VERCEL_ENV` alone can be the source of truth — both sides must derive
the **identical** string or producer and consumer never meet.

Use one explicit, shared variable:

```
PIPELINE_QUEUE_NAME
```

```ts
// identical in both apps
export const QUEUE_NAME = process.env.PIPELINE_QUEUE_NAME ?? "jobtrackr-pipeline-dev";
```

**The default must be the dev name, not production.** Forgetting to set it locally then
yields isolation (safe). If the default were the production name, forgetting it locally
would silently rejoin production — the exact failure being fixed.

Deliberately *not* auto-derived from `FLY_APP_NAME`/`VERCEL_ENV`: that would couple the
frontend to the worker's Fly app name, and a rename on either platform would decouple the
two halves silently.

### 3.2 Fail loud in production

The dev-safe default has one weakness: forgetting to set it *in production* is silent,
because both sides consistently use the dev queue and everything appears to work. Add a
startup assertion so that misconfiguration is caught at deploy time.

Worker — `backend/worker/src/index.ts`, before constructing the `Worker`:

```ts
// FLY_APP_NAME is injected by Fly and absent everywhere else.
if (process.env.FLY_APP_NAME && !process.env.PIPELINE_QUEUE_NAME) {
  throw new Error(
    "PIPELINE_QUEUE_NAME must be set on a Fly deployment — refusing to start on the dev queue",
  );
}
```

Frontend — at the enqueue sites, log an error (do **not** throw; a misconfigured env var
should not take the app down):

```ts
if (process.env.VERCEL_ENV === "production" && !process.env.PIPELINE_QUEUE_NAME) {
  console.error("[queue] PIPELINE_QUEUE_NAME unset in production — enqueueing to the dev queue");
}
```

### 3.3 Other keys

Apply the same namespace to the remaining prefixes. These are worker-local (no
cross-app coordination needed), so they can use `FLY_APP_NAME ?? "local"` directly —
the pattern already shipped in `healthTracker.ts`:

- `jobtrackr:alert:sent:*`
- `jobtrackr:worker:expected_shutdown`

For `rl:*` in the frontend, namespace on `VERCEL_ENV ?? "local"`.

---

## 4. Migration

**Production keeps its existing queue name**, so there is no drain problem and no
in-flight job loss. Only non-production diverges.

Ordering matters, but the window is safe at every step because the old code ignores
`PIPELINE_QUEUE_NAME` entirely:

1. **Set the env var first, before any code ships.**
   - Fly: `flyctl secrets set PIPELINE_QUEUE_NAME=jobtrackr-pipeline -a jobtrackr-worker`
   - Vercel: add `PIPELINE_QUEUE_NAME=jobtrackr-pipeline`, **Production scope only** —
     leave it unset for Preview and Development so those isolate automatically.
   - No behaviour change: current code doesn't read it.

2. **Deploy the worker.** It now reads the var and listens on `jobtrackr-pipeline` — the
   same name as before. Old frontend still enqueues there. No gap.

3. **Redeploy the frontend.** Vercel env changes only apply to new deployments, so a
   redeploy is required even though the variable was added in step 1. Enqueues to the same
   name. No gap.

4. **Verify** (see §5), then update both `.env.example` files to document the variable and
   state that leaving it unset is the correct local default.

### Rollback

Unset `PIPELINE_QUEUE_NAME` in production and both sides fall back to
`jobtrackr-pipeline-dev` together — still consistent, just misnamed. Cleaner rollback is
reverting the deploys; the queue name never changed for production, so nothing is stranded.

---

## 5. Verification

- [ ] Worker logs `[worker] started — queue: jobtrackr-pipeline` after step 2 (it already
      prints the queue name at `index.ts:98`).
- [ ] Trigger a run from the deployed frontend → job is picked up. Confirms producer and
      consumer agree.
- [ ] Locally: `npm run dev` in `backend/worker` with `PIPELINE_QUEUE_NAME` unset, then
      trigger a run in production. **The local worker must not pick it up.** This is the
      whole point of the change — test it explicitly.
- [ ] `redis-cli KEYS 'bull:*'` (or an ioredis one-liner; the Fly image has no
      `redis-cli`) shows both `bull:jobtrackr-pipeline:*` and, once a dev run happens,
      `bull:jobtrackr-pipeline-dev:*` as separate trees.

---

## 6. Complementary option — a separate Upstash DB for dev

Namespacing is enforcement. The cleaner convention is to **give local development its own
Upstash database**: it isolates the queue, rate limits, alerts, heartbeat, and anything
added later, with zero code.

Worth doing *in addition*, not instead — a convention in `.env.example` does not stop a
developer from pasting the production URL, whereas the namespace default still protects
them if they do. Recommended: adopt both, and document the separate DB as the default dev
setup.

---

## 7. Out of scope / open questions

- **Vercel environment mapping needs confirming.** `CLAUDE.md` states this repo's `main`
  deploys to a Vercel *preview*, not production, while `deploy.yml` deploys `main` to the
  real Fly worker. Before step 1, confirm which Vercel environment(s) actually talk to
  this Redis, so `PIPELINE_QUEUE_NAME` is scoped to the right one. If the live frontend
  runs under Preview scope, the variable belongs there instead — otherwise the frontend
  isolates itself away from the worker and nothing runs.
- Queue-name changes for `backend/api` — not applicable; it does not touch BullMQ.
- Splitting Supabase per environment — much larger, unrelated, not proposed here.

# ⚠️ DO NOT DELETE AS "DEAD CODE"

This is one of four **deployable Apify actor packages** colocated under
`backend/worker/src/sources/` (siblings: `seek_ts/`, `careerjet_actor/`,
`adzuna_actor/`) — not part of the worker's own runtime dispatch, so a
grep for cross-file TypeScript imports finds none and a naive "unused
directory" check will flag this as dead weight. It has its own
`package.json`/`package-lock.json`/`Dockerfile`/`tsconfig.json` because it
is built and deployed to Apify independently of the worker. Deliberately
excluded from the worker's own build in `backend/worker/tsconfig.json`'s
`exclude` list.

See `docs/ARCHITECTURE_MAP.md` for the full colocated-deployables
explanation. Whether this specific actor still exists on Apify is
**unresolved** — that needs Apify console access to confirm, not a repo
grep — so do not delete this on a "probably orphaned" guess either way.
(Audit finding #66 — previously mis-described as "136K dead weight"; 96K
of that is `package-lock.json`, `src/` itself is 8K.)

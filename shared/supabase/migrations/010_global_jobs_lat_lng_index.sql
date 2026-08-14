-- ============================================================
-- JobTrackr-CV — 010_global_jobs_lat_lng_index.sql
-- Apply standalone (no other migrations depend on this).
--
-- Indexes the lat/lng bounding-box scan bucket.ts has always claimed was
-- indexed.
--
-- Audit finding (execution chunk C58, ~/.claude/plans/EXECUTION-PLAN.md):
-- backend/worker/src/pipeline/bucket.ts:399's own comment says "Bounding
-- box (square superset of the radius circle) on indexed lat/lng" but
-- global_jobs has never had a lat/lng index (confirmed against
-- 001_full_schema.sql: only location_cell, matched_keywords (gin),
-- posted_at, first_seen_at are indexed) -- every serveProfileFromBucket()
-- call was a full sequential scan for lat/lng range matches.
--
-- Additive only, per CLAUDE.md's Non-Negotiable #6 -- CREATE INDEX does not
-- alter the table's structure or existing data.
--
-- Partial + composite, scoped to exactly bucket.ts's real query shape
-- (is_dead_link = false AND is_expired = false, then a lat/lng bounding
-- box) rather than a blanket index over the whole table -- smaller to
-- build and maintain, and Postgres can use a (lat, lng) btree for a range
-- scan on lat narrowed by lng within that range, which is a large
-- improvement over a full seq scan even though it isn't a true 2D
-- spatial index (that would need PostGIS or the cube/earthdistance
-- extension -- a bigger operational change than this finding calls for).
--
-- CONCURRENTLY: global_jobs is a live table under constant write traffic
-- from the scrape pipeline. A plain CREATE INDEX takes a lock that blocks
-- writes for the build's duration; CONCURRENTLY avoids that at the cost of
-- a slower build. Run this as the ONLY statement in a single Supabase SQL
-- editor execution -- CONCURRENTLY cannot run inside a transaction block,
-- and pasting it alongside other statements risks the editor wrapping the
-- whole paste in one.
create index concurrently if not exists idx_global_jobs_active_lat_lng
  on public.global_jobs (lat, lng)
  where is_dead_link = false and is_expired = false;

-- Verify AFTER running (CONCURRENTLY can leave an INVALID index behind on
-- a failed build — IF NOT EXISTS alone will not detect that, it only
-- checks the name, so a silent no-op re-run would leave the finding
-- looking closed when it isn't):
--   select indexrelid::regclass, indisvalid from pg_index
--   where indexrelid = 'public.idx_global_jobs_active_lat_lng'::regclass;
-- If indisvalid = false: drop index concurrently if exists idx_global_jobs_active_lat_lng;
-- then re-run the CREATE INDEX statement above.

-- Rollback (one line): drop index concurrently if exists idx_global_jobs_active_lat_lng;

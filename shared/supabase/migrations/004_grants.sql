-- ============================================================
-- JobTrackr — 004_grants.sql (added 2026-08-07)
--
-- Baseline table/sequence/function privileges for the standard Supabase
-- roles. Apply AFTER 001_full_schema.sql + 002_rls.sql + 003_seed.sql.
--
-- Supabase normally provisions these automatically per-project, so on a
-- project created through the Supabase dashboard this is a no-op. But
-- 001's header claim — "001 + 002 + 003 on a fresh database reproduces
-- the full setup" — turned out to be false for a database whose schema
-- was applied via raw SQL outside that per-project auto-provisioning
-- (e.g. migrating to a new Supabase project by re-running these files):
-- every table came back `permission denied` for anon/authenticated/
-- service_role, since nothing had ever granted them access to `public`.
-- RLS policies (002) then restrict rows for anon/authenticated as
-- designed; this file only restores the table-access baseline they need
-- to run a query at all. All statements are idempotent — safe to re-run,
-- including against an already-correctly-provisioned project.
-- ============================================================

grant usage on schema public to anon, authenticated, service_role;
grant all on all tables    in schema public to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;
grant all on all routines  in schema public to anon, authenticated, service_role;

alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on routines  to anon, authenticated, service_role;

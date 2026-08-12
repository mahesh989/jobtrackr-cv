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
--
-- ⚠ Corrected 2026-08-12 (chunk C4, finding #42) — the "safe to re-run in
-- isolation" claim above was FALSE for one specific grant: line 22's
-- blanket `grant all on all tables` includes UPDATE on public.users,
-- which is how any authenticated user could escalate their own role to
-- 'admin' (finding #42 — rated the single highest-severity finding in
-- the whole audit). 007_users_role_column_protection.sql fixes this with
-- `revoke update on public.users from anon, authenticated`, but an
-- independent review caught that re-running JUST this file afterward
-- (in isolation, e.g. "let me re-apply grants for hygiene") would
-- silently restore the blanket UPDATE and reopen the escalation —
-- verified empirically. The line immediately below keeps this file
-- correct and self-consistently re-runnable on its own, matching the
-- "safe to re-run" promise above, instead of relying on migration order
-- across files. If a future feature needs authenticated/anon to write a
-- specific users column, grant it explicitly by column — never restore
-- the blanket UPDATE on this table.
-- ============================================================

grant usage on schema public to anon, authenticated, service_role;
grant all on all tables    in schema public to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;
grant all on all routines  in schema public to anon, authenticated, service_role;

alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on routines  to anon, authenticated, service_role;

-- Keep finding #42 closed even if this file is re-run alone — see the
-- correction note above. Must stay the LAST statement in this file.
-- Guarded (rather than a bare REVOKE) so this file doesn't hard-fail if
-- ever run before 001_full_schema.sql creates public.users — independent
-- review flagged the unguarded form as a real, if minor, ordering
-- footgun.
do $$ begin
  if to_regclass('public.users') is not null then
    revoke update on public.users from anon, authenticated;
  end if;
end $$;

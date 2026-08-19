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
--
-- ⚠ Corrected again 2026-08-12 (chunk C5, findings #44 + B4-P2) — same
-- root cause, different grant: line 41's blanket `grant all on all
-- routines` silently undoes 001_full_schema.sql's own deliberate
-- `revoke execute ... from public` on replace_stories (:827) and
-- check_user_auth_methods (:1644), and never had an equivalent revoke
-- for consume_usage in the first place (it kept Postgres's default
-- EXECUTE-to-PUBLIC grant since its creation). All three are
-- SECURITY DEFINER functions that take a target user as a plain
-- parameter with no auth.uid() ownership check — reachable, this
-- combination lets any authenticated user overwrite another user's
-- stories or billing-ledger rows, and lets anyone (anon included)
-- enumerate account existence. An independent review of chunk C4
-- live-verified this exploitable, not just theoretical.
-- 008_admin_views_and_rpc_grants.sql fixes this; the guarded block below
-- is the same re-run durability guard as C4's, applied to these three
-- functions.
--
-- ⚠ Second independent review of C5 itself (2026-08-12) found the C5 fix
-- above only guarded the REVOKE half of finding #43/#44, not the two
-- `security_invoker` view options 008 also sets — and proved by replay
-- that a plain `create or replace view` (exactly what 001_full_schema.sql
-- does) SILENTLY RESETS `security_invoker` back to unset. Table/function
-- grants survive a bare `create or replace`; view reloptions do not. So
-- the view half of #43 was the MORE fragile of the two fixes and had NO
-- durability guard at all until the block below. Also requires PG15+ —
-- guarded with a version check so this file doesn't hard-fail against an
-- older project (see 008's header for the full statement-ordering
-- rationale; this 004 copy exists purely for the "file re-run in
-- isolation" case, same as every other guard in this file).
-- ============================================================

grant usage on schema public to anon, authenticated, service_role;
grant all on all tables    in schema public to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;
grant all on all routines  in schema public to anon, authenticated, service_role;

alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on routines  to anon, authenticated, service_role;

-- Keep finding #42 closed even if this file is re-run alone — see the
-- correction note above. Must stay AFTER the blanket `grant all on all
-- tables` above, which is specifically what would re-open it. (Not every
-- corrective block below has this same requirement — the view-alter block
-- further down is guarding against a DIFFERENT hazard, a re-run of 001's
-- `create or replace view`, and is unaffected by the grants above either
-- way; independently verified. Each block's own comment states what it
-- actually needs to come after — don't assume "after the grants" applies
-- file-wide.)
-- Guarded (rather than a bare REVOKE) so this file doesn't hard-fail if
-- ever run before 001_full_schema.sql creates public.users — independent
-- review flagged the unguarded form as a real, if minor, ordering
-- footgun.
do $$ begin
  if to_regclass('public.users') is not null then
    revoke update on public.users from anon, authenticated;
  end if;
end $$;

-- Keep findings #44 + B4-P2 closed even if this file is re-run alone —
-- see the C5 correction note above. Must stay AFTER the blanket grants
-- above (see the ordering note on the users.role block).
-- Guarded the same way as the users.role fix above, so this file doesn't
-- hard-fail if ever run before 001_full_schema.sql creates these
-- functions.
do $$ begin
  if to_regprocedure('public.check_user_auth_methods(text)') is not null then
    revoke execute on function public.check_user_auth_methods(text)
      from public, anon, authenticated;
  end if;
  if to_regprocedure('public.replace_stories(uuid, jsonb)') is not null then
    revoke execute on function public.replace_stories(uuid, jsonb)
      from public, anon, authenticated;
  end if;
  if to_regprocedure('public.consume_usage(uuid, text, uuid, int, int, timestamptz)') is not null then
    revoke execute on function public.consume_usage(uuid, text, uuid, int, int, timestamptz)
      from public, anon, authenticated;
  end if;
  if to_regprocedure('public.reserve_run_usage(uuid, uuid, uuid, boolean, int, timestamptz)') is not null then
    revoke execute on function public.reserve_run_usage(uuid, uuid, uuid, boolean, int, timestamptz)
      from public, anon, authenticated;
  end if;
  if to_regprocedure('public.commit_run_usage(uuid)') is not null then
    revoke execute on function public.commit_run_usage(uuid)
      from public, anon, authenticated;
  end if;
  if to_regclass('public.run_usage_requests') is not null then
    revoke all on table public.run_usage_requests from public, anon, authenticated;
  end if;
end $$;

-- Keep finding #43's view fix durable across a re-run of 001 (which resets
-- it, see the C5 correction note above). Version-guarded: security_invoker
-- for views needs PG15+; this no-ops rather than errors on an older project.
do $$ begin
  if current_setting('server_version_num')::int >= 150000 then
    if to_regclass('public.admin_integrations_overview') is not null then
      execute 'alter view public.admin_integrations_overview set (security_invoker = true)';
    end if;
    if to_regclass('public.admin_daily_ai_cost') is not null then
      execute 'alter view public.admin_daily_ai_cost set (security_invoker = true)';
    end if;
  end if;
end $$;

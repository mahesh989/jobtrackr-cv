-- ============================================================
-- JobTrackr-CV — 005_rls_analysis_runs_cover_letters_readonly.sql
-- Apply AFTER 002_rls.sql.
--
-- Fixes audit finding #49 (P0, execution-plan chunk C3): "any user can get
-- unlimited free tailored CVs and cover letters by voiding their own paid
-- reservation."
--
-- Root cause. "users_own_analysis_runs" / "users_own_cover_letters" were
-- FOR ALL policies with `using (auth.uid() = user_id) with check
-- (auth.uid() = user_id)`. Postgres RLS restricts which ROWS a policy
-- matches, never which COLUMNS — so the `authenticated` role (granted ALL
-- on all tables by 004_grants.sql) could PATCH any column on its own row,
-- including `status`. A SECURITY DEFINER trigger
-- (analysis_runs_usage_sync / cover_letters_usage_sync,
-- 001_full_schema.sql:1290-1296) then voids the linked usage-ledger
-- reservation on a transition to `status = 'failed'` — while the async
-- cv-backend pipeline keeps running regardless, because it only aborts
-- when `error_message` starts with "cancelled"
-- (backend/api/app/services/pipeline/orchestrator.py:105). Net effect: the
-- artifact is still delivered, the paid reservation is refunded, repeatable
-- without limit.
--
-- Fix and why it's safe. Every INSERT/UPDATE/DELETE this app performs on
-- `analysis_runs` and `cover_letters` — across all three services
-- (frontend/web, backend/worker, backend/api) — goes exclusively through
-- the Supabase service-role client, which bypasses RLS entirely. Confirmed
-- by an exhaustive repo-wide trace 2026-08-12 (every file referencing
-- either table name was read; every .insert()/.update()/.delete() call
-- site uses createAdminClient() / SUPABASE_SERVICE_ROLE_KEY, none use the
-- user-scoped/browser client — see EXECUTION-LOG.md [C3] for the full
-- file list). The `authenticated` role only ever needs SELECT: ownership
-- checks in server actions (e.g. cancelAnalysisRun in
-- frontend/web/src/lib/actions/runs.ts, which itself writes via the admin
-- client, not the user-scoped one) and the Realtime postgres_changes
-- subscription that drives live step-status on the analysis page
-- (AnalysisRunClient.tsx). There is therefore no legitimate client write
-- path to close narrowly (e.g. by pinning just the `status` column) —
-- dropping ALL client write access removes the entire vulnerability class,
-- not only the one column the audit traced.
--
-- Non-Negotiable Decision #6 (additive-only). This drops and recreates two
-- RLS POLICIES — not a table/column ALTER, DROP TABLE, or data change.
-- Service-role access is completely untouched (RLS does not apply to it),
-- so cv-backend / worker / the admin client keep reading and writing these
-- tables exactly as before. No other policy, table, or grant is modified.
--
-- Rollback (one line): re-run the FOR ALL policy from 002_rls.sql —
--   drop policy "users_read_own_analysis_runs" on public.analysis_runs;
--   create policy "users_own_analysis_runs" on public.analysis_runs
--     for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
--   (same shape for cover_letters).
-- ============================================================

drop policy if exists "users_own_analysis_runs" on public.analysis_runs;
drop policy if exists "users_read_own_analysis_runs" on public.analysis_runs;

create policy "users_read_own_analysis_runs"
  on public.analysis_runs
  for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "users_own_cover_letters" on public.cover_letters;
drop policy if exists "users_read_own_cover_letters" on public.cover_letters;

create policy "users_read_own_cover_letters"
  on public.cover_letters
  for select
  to authenticated
  using (auth.uid() = user_id);

-- ============================================================
-- JobTrackr-CV — 009_cv_versions_rls_readonly.sql
-- Apply AFTER 002_rls.sql.
--
-- Fixes finding B4-P2 (execution-plan chunk C12) — "cv_versions.
-- pdf_storage_path is client-writable, and /api/cv/[id]/route.ts:46-49
-- mints a service-role signed URL for whatever path the row holds —
-- bypassing cvs_owner_select. Needs two known UUIDs, hence P2."
--
-- Root cause — same shape as finding #49 (chunk C3). "users_own_cv_
-- versions" (002_rls.sql:183-187) is `for all using (auth.uid() =
-- user_id) with check (auth.uid() = user_id)` — row-scoped only, so it
-- permits an authenticated user to PATCH ANY column on their own
-- cv_versions row via the REST API, including pdf_storage_path.
--
-- Exploit chain (needs two known UUIDs — the attacker's own cv_version
-- id, and a target user's storage path, hence P2 not P0):
--   1. supabase.from("cv_versions")
--        .update({ pdf_storage_path: "<victim_user_id>/<victim_cv_id>.pdf" })
--        .eq("id", "<attacker's own cv_version id>")
--      — RLS permits it (own row), the grant permits it (004's blanket
--      table grant), nothing validates the new value is a path the
--      attacker actually owns in the "cvs" bucket.
--   2. GET /api/cv/[attacker's own cv_version id] — the route's ownership
--      check (`.eq("user_id", user.id)`) passes (their own row), then
--      mints a signed URL for `data.pdf_storage_path` AS STORED — the
--      victim's real PDF — with the service-role client, bypassing
--      Storage's own `cvs_owner_select` RLS entirely.
--
-- Fix. Traced exhaustively (see EXECUTION-LOG.md chunk C12): every write
-- to cv_versions anywhere in this codebase — 7 files in frontend/web
-- (app/api/cv/route.ts, app/api/cv/create/route.ts, app/api/cv/[id]/
-- route.ts, app/api/cv/[id]/recategorise/route.ts, app/api/cv/[id]/
-- structured/route.ts, lib/cv/structurizeAndCategorise.ts, lib/cv/
-- ensureActive.ts, lib/analyze/start.ts) and 1 file in backend/worker
-- (automation/triggerAutoAnalyze.ts) — uses the service-role client
-- (createAdminClient() / worker's db client, both bypass RLS entirely).
-- ensureSomeoneActive()'s admin parameter is even typed as
-- `ReturnType<typeof createAdminClient>`, so TypeScript itself refuses a
-- user-scoped client at every call site. Zero legitimate writes exist via
-- the user-scoped client, so — same pattern as
-- 005_rls_analysis_runs_cover_letters_readonly.sql for
-- analysis_runs/cover_letters — this replaces the FOR ALL policy with
-- SELECT-only, closing the entire write class rather than pinning one
-- column.
--
-- What this does NOT additionally do, and why that's fine: it would also
-- be reasonable to harden /api/cv/[id]/route.ts's signed-URL minting to
-- validate pdf_storage_path starts with `${user.id}/` before calling
-- createSignedUrl — defense in depth. Not done here: after this RLS fix,
-- pdf_storage_path can only ever be set by the service-role code paths
-- above, which already always compute it correctly
-- (`${user_id}/${cv_id}.${ext}` or the `built://` sentinel) — there is no
-- longer any avenue for it to hold an attacker-chosen value at all, so
-- the extra check would be redundant with what this migration already
-- closes. Matches this repo's established precedent (C3, C4, C5): close
-- the write hole, don't layer read-side validation on top of a value
-- that can no longer be wrong.
--
-- Non-Negotiable Decision #6 (additive-only). This is an RLS policy
-- replacement (`drop policy` / `create policy`), never an `ALTER TABLE`,
-- exactly the pattern 005 already established for the same finding
-- class.
--
-- Rollback (one line): re-create the FOR ALL policy from 002_rls.sql.
-- ============================================================

drop policy if exists "users_own_cv_versions" on public.cv_versions;
drop policy if exists "users_read_own_cv_versions" on public.cv_versions;

create policy "users_read_own_cv_versions"
  on public.cv_versions
  for select
  to authenticated
  using (auth.uid() = user_id);

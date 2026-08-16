-- ============================================================
-- JobTrackr-CV — 012_append_run_log_lines_batch.sql
-- Apply standalone (no other migrations depend on this).
--
-- Execution chunk C55b, filed from C55's phase-0 investigation
-- (migration-free PR #182, merged). append_run_log_line(rid, line)
-- (migration 001, "-- 030: atomic single-line log append") does a full
-- server-side read-modify-write of the WHOLE growing log_lines jsonb
-- blob on every single console.log call — once the column TOASTs
-- (~2KB, reached within a handful of lines) every subsequent append
-- decompresses/recompresses the entire blob, and logContext.ts fires
-- one RPC per line (302 call sites worker-wide).
--
-- This is additive, not a replacement: append_run_log_line() is left
-- untouched (CLAUDE.md's additive-only rule) even though logContext.ts's
-- accompanying worker-side change stops calling it, in case anything
-- else in flight still references it. append_run_log_lines(rid, lines)
-- is the same read-modify-write, but over a caller-buffered batch of
-- lines in one call instead of one call per line — the same asymptotic
-- shape, but with the RPC-count (and therefore round-trip and
-- decompress/recompress) divisor equal to the batch size instead of 1.
-- A true O(1)-per-line fix needs an append-only table redesign — filed
-- separately as C55c, contingent on this shipping first.
-- coalesce() on BOTH sides of || is required, not just log_lines: jsonb ||
-- is strict, so a SQL NULL `lines` argument (a caller bug, or PostgREST
-- serializing an omitted/undefined arg through as NULL) would otherwise
-- make the whole expression evaluate to NULL and WIPE the run's entire
-- log_lines history on that single UPDATE (migration-checker review).
create or replace function public.append_run_log_lines(rid uuid, lines jsonb)
returns void
language sql
as $$
  update public.run_logs
  set log_lines = coalesce(log_lines, '[]'::jsonb) || coalesce(lines, '[]'::jsonb)
  where id = rid;
$$;

revoke execute on function public.append_run_log_lines(uuid, jsonb)
  from public, anon, authenticated;

-- Rollback:
--   drop function if exists public.append_run_log_lines(uuid, jsonb);

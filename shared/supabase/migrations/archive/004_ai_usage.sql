-- ============================================================
-- Migration 004: AI usage tracking columns on run_logs
-- Apply via Supabase SQL Editor after 002_rls.sql
-- ============================================================

alter table public.run_logs
  add column if not exists ai_tokens_input  int not null default 0,
  add column if not exists ai_tokens_output int not null default 0,
  add column if not exists ai_cost_cents    int not null default 0,  -- USD cents × 100 (millicents)
  add column if not exists ai_batch_id      text;                    -- Anthropic batch ID if async

-- Helper: total AI spend in millicents for a user in the current calendar month
-- Used by cost cap enforcement in the worker.
create or replace function public.monthly_ai_spend_millicents(p_user_id uuid)
returns int
language sql stable
as $$
  select coalesce(sum(rl.ai_cost_cents), 0)::int
  from   public.run_logs rl
  join   public.search_profiles sp on sp.id = rl.profile_id
  where  sp.user_id = p_user_id
    and  rl.started_at >= date_trunc('month', now());
$$;

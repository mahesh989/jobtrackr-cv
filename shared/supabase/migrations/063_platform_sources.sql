-- Migration 063 — platform-wide job-source selection (admin-controlled).
--
-- Source selection + per-source method moved OFF the per-profile job-search
-- form and onto a single admin-controlled config (mirrors platform_ai_settings).
-- Whatever the admin ticks in Admin → Integrations → Job sources applies to
-- every user's pipeline runs. The orchestrator reads this row and overrides
-- the (now-vestigial) per-profile enabled_sources / seek_method / adzuna_method
-- columns at run time.
--
-- Single-row table (id = 1).

create table if not exists public.platform_sources (
  id               int  primary key default 1 check (id = 1),
  enabled_sources  text[] not null default '{adzuna,seek,careerjet}',
  adzuna_method    text not null default 'direct' check (adzuna_method in ('api', 'direct')),
  seek_method      text not null default 'direct' check (seek_method in ('direct', 'actor')),
  updated_at       timestamptz not null default now(),
  updated_by       uuid references auth.users(id)
);

-- Seed the single row.
insert into public.platform_sources (id) values (1)
on conflict (id) do nothing;

alter table public.platform_sources enable row level security;

-- Service-role only — admin API routes use createAdminClient(); the worker
-- reads it with the service-role client. No end-user client touches it.
create policy "service role full access" on public.platform_sources
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

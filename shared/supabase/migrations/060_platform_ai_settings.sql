-- Platform-wide AI provider settings, replacing per-user BYOK.
--
-- Admin (founder/admin role) configures ONE active provider + key + model
-- in Settings → Admin → AI provider. Every user's analyses, cover letters,
-- company research, voice/story extraction, etc. use this single active
-- row. Exactly one provider may be active at a time (partial unique index).

create table if not exists public.platform_ai_settings (
  id                 uuid primary key default gen_random_uuid(),
  provider           text not null unique check (provider in ('anthropic', 'openai', 'deepseek')),
  encrypted_api_key  text,
  model              text,
  is_active          boolean not null default false,
  status             text,                 -- 'valid' | 'invalid' | null (untested)
  status_reason      text,
  last_validated_at  timestamptz,
  updated_at         timestamptz not null default now(),
  updated_by         uuid references auth.users(id)
);

create unique index if not exists platform_ai_settings_one_active
  on public.platform_ai_settings (is_active)
  where is_active;

alter table public.platform_ai_settings enable row level security;

-- Service-role only (admin API routes use createAdminClient()); no end-user
-- client ever reads/writes this table directly.
create policy "service role full access" on public.platform_ai_settings
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

insert into public.platform_ai_settings (provider, model, is_active)
values
  ('openai',    'gpt-5.1',          true),
  ('anthropic', 'claude-sonnet-4-6', false),
  ('deepseek',  'deepseek-chat',     false)
on conflict (provider) do nothing;

-- Best-effort migration: carry over a previously-connected admin/founder BYOK
-- key (the integrations page was already admin-only) so the platform isn't
-- left keyless after this migration runs.
insert into public.platform_ai_settings (provider, encrypted_api_key, model, status, status_reason, last_validated_at)
select
  ui.provider,
  ui.encrypted_api_key,
  coalesce(ui.config ->> 'model', case ui.provider
    when 'openai'    then 'gpt-5.1'
    when 'anthropic' then 'claude-sonnet-4-6'
    else 'deepseek-chat'
  end),
  ui.status,
  ui.status_reason,
  ui.last_validated_at
from public.user_integrations ui
join public.users u on u.id = ui.user_id
where ui.provider in ('anthropic', 'openai', 'deepseek')
  and u.role in ('founder', 'admin')
  and ui.encrypted_api_key is not null
on conflict (provider) do update set
  encrypted_api_key  = excluded.encrypted_api_key,
  model              = excluded.model,
  status             = excluded.status,
  status_reason      = excluded.status_reason,
  last_validated_at  = excluded.last_validated_at;

-- Keep exactly one active row: prefer openai if it now has a migrated key,
-- otherwise fall back to whichever provider has a valid key, otherwise leave
-- openai active (admin must paste a key before analyses can run).
update public.platform_ai_settings set is_active = false;
update public.platform_ai_settings set is_active = true
where provider = (
  select provider from public.platform_ai_settings
  where status = 'valid' and encrypted_api_key is not null
  order by (provider = 'openai') desc, (provider = 'anthropic') desc
  limit 1
);
update public.platform_ai_settings set is_active = true
where provider = 'openai'
  and not exists (select 1 from public.platform_ai_settings where is_active);

-- BYOK is removed — drop the per-user key rows now that platform_ai_settings
-- is the sole source of truth. Apify + email_integrations are unaffected
-- (different providers in the same table, untouched by this filter).
delete from public.user_integrations
where provider in ('anthropic', 'openai', 'deepseek');

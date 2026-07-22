-- ============================================================
-- JobTrackr — 003_seed.sql (squashed 2026-07-23)
-- Static platform configuration data, consolidated to its NET FINAL
-- state after migrations 003–082. Apply AFTER 002_rls.sql.
--
-- Every INSERT here is idempotent (on conflict do update/nothing) so
-- re-running this file is safe.
-- ============================================================

-- ── STORAGE BUCKETS (013 + 019 markdown widening + 036) ─────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'cvs',
  'cvs',
  false,
  5 * 1024 * 1024,                  -- 5 MB cap
  array[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]
)
on conflict (id) do update set
  file_size_limit    = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types,
  public             = excluded.public;

-- tailored-cvs: PDF + markdown (the pipeline uploads .md before the PDF
-- render — 019 widened the original PDF-only allow-list).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'tailored-cvs',
  'tailored-cvs',
  false,
  10 * 1024 * 1024,                 -- 10 MB cap (generated PDFs can be large)
  array['application/pdf', 'text/markdown']
)
on conflict (id) do update set
  file_size_limit    = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types,
  public             = excluded.public;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'cover-letters',
  'cover-letters',
  false,
  5 * 1024 * 1024,                  -- 5 MB cap
  ARRAY['application/pdf']
)
ON CONFLICT (id) DO UPDATE SET
  file_size_limit    = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types,
  public             = excluded.public;

-- ── PLAN CATALOGUE (051, net of 061-revert + 082 caps/price fixes) ──
-- Weekly caps are the restored 051 values (082 reversed 061's unlimited
-- experiment). Monthly/unlimited price_cents are the finalized 2026-06-23
-- prices (1999 / 2999), not the 051 placeholders.
insert into public.plans
  (id, display_name, stripe_price_id, billing_interval, trial_days,
   max_profiles, max_runs, max_cv_unique, max_cv_total, max_letter_unique, max_letter_total,
   price_cents, sort_order, is_public)
values
  ('trial',     'Free trial',  null, 'day',   3,  1,   1,    3,    3,    3,    3,        0,   0, false),
  ('weekly',    'Weekly',      null, 'week',  0,  5,   30,   50,   75,   50,   75,     999,   1, true),
  ('monthly',   'Monthly',     null, 'month', 0,  10,  120,  250,  375,  250,  375,   1999,   2, true),
  ('unlimited', 'Unlimited',   null, 'month', 0,  null, null, null, null, null, null,  2999,   3, true),
  ('comp',      'Complimentary', null, 'month', 0, null, null, null, null, null, null,    0, 100, false)
on conflict (id) do update set
  display_name      = excluded.display_name,
  billing_interval  = excluded.billing_interval,
  trial_days        = excluded.trial_days,
  max_profiles      = excluded.max_profiles,
  max_runs          = excluded.max_runs,
  max_cv_unique     = excluded.max_cv_unique,
  max_cv_total      = excluded.max_cv_total,
  max_letter_unique = excluded.max_letter_unique,
  max_letter_total  = excluded.max_letter_total,
  price_cents       = excluded.price_cents,
  sort_order        = excluded.sort_order,
  is_public         = excluded.is_public;

-- ── PLATFORM AI SETTINGS (060) — one row per provider, openai active ─
insert into public.platform_ai_settings (provider, model, is_active)
values
  ('openai',    'gpt-5.1',          true),
  ('anthropic', 'claude-sonnet-4-6', false),
  ('deepseek',  'deepseek-chat',     false)
on conflict (provider) do nothing;

-- ── PLATFORM SOURCES (063) — the single global row ──────────────────
insert into public.platform_sources (id) values (1)
on conflict (id) do nothing;

-- ── PLATFORM SOURCE TIERS (064, net of 070–077) ─────────────────────
-- The unlimited tier's enabled_sources is the NET result of the
-- 070→077 enable/pause sequence (Workday agedcare kept; the four JS-ATS
-- adapters paused by 072; radancy/avature/dayforce/successfactors/adlogic
-- re-enabled individually). Array order matches the sequentially-applied
-- result exactly.
insert into public.platform_source_tiers (tier, enabled_sources, adzuna_method, seek_method) values
  ('weekly',    '{adzuna,seek,careerjet}', 'api',    'direct'),
  ('monthly',   '{adzuna,seek,careerjet}', 'api',    'direct'),
  ('unlimited', '{seek,adzuna,agedcare,careerjet,radancy,avature,agedcare_dayforce,successfactors,adlogic}', 'direct', 'direct')
on conflict (tier) do nothing;

-- ============================================================
-- FOUNDER SEED — OPERATOR STEP, DO NOT RUN AS-IS (was 003_seed_founder)
-- ============================================================
-- Run manually AFTER creating your account. Replace YOUR_USER_ID with
-- your auth.users UUID (Supabase Dashboard → Authentication → Users),
-- then execute the block. It is commented out because YOUR_USER_ID is
-- not valid SQL and must never run un-substituted.
--
-- -- 1. Set founder role
-- update public.users
-- set role = 'founder'
-- where id = 'YOUR_USER_ID';
--
-- -- 2. Generate first batch of invite codes (generate more as needed)
-- insert into public.invite_codes (code, created_by, is_active)
-- values
--   ('JT-' || upper(substr(gen_random_uuid()::text, 1, 8)), 'YOUR_USER_ID', true),
--   ('JT-' || upper(substr(gen_random_uuid()::text, 1, 8)), 'YOUR_USER_ID', true),
--   ('JT-' || upper(substr(gen_random_uuid()::text, 1, 8)), 'YOUR_USER_ID', true),
--   ('JT-' || upper(substr(gen_random_uuid()::text, 1, 8)), 'YOUR_USER_ID', true),
--   ('JT-' || upper(substr(gen_random_uuid()::text, 1, 8)), 'YOUR_USER_ID', true);
--
-- -- 3. Verify
-- select code, is_active from public.invite_codes where created_by = 'YOUR_USER_ID';

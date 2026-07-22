-- ============================================================
-- JobTrackr — Migration 003: Founder seed data
-- Run AFTER 002_rls.sql, AFTER you have created your account.
-- Replace YOUR_USER_ID with your auth.users UUID (visible in
-- Supabase Dashboard → Authentication → Users).
-- ============================================================

-- 1. Set founder role
update public.users
set role = 'founder'
where id = 'YOUR_USER_ID';

-- 2. Generate first batch of invite codes (generate more as needed)
insert into public.invite_codes (code, created_by, is_active)
values
  ('JT-' || upper(substr(gen_random_uuid()::text, 1, 8)), 'YOUR_USER_ID', true),
  ('JT-' || upper(substr(gen_random_uuid()::text, 1, 8)), 'YOUR_USER_ID', true),
  ('JT-' || upper(substr(gen_random_uuid()::text, 1, 8)), 'YOUR_USER_ID', true),
  ('JT-' || upper(substr(gen_random_uuid()::text, 1, 8)), 'YOUR_USER_ID', true),
  ('JT-' || upper(substr(gen_random_uuid()::text, 1, 8)), 'YOUR_USER_ID', true);

-- 3. Verify
select code, is_active from public.invite_codes where created_by = 'YOUR_USER_ID';

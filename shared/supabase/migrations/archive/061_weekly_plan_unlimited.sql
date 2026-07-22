-- 061_weekly_plan_unlimited.sql
--
-- Migration 051 set weekly plan with caps (50/75 CVs, 5 profiles, 30 runs).
-- Commit 9a3defb (2026-06-15) changed the intent to unlimited, but only edited
-- the already-applied migration file and the TypeScript constant — the DB row
-- was never updated. loadLimits() reads the DB first, so the old caps stayed.
--
-- This migration corrects the plans table to match the intended unlimited state.

update public.plans
set
  max_profiles      = null,
  max_runs          = null,
  max_cv_unique     = null,
  max_cv_total      = null,
  max_letter_unique = null,
  max_letter_total  = null
where id = 'weekly';

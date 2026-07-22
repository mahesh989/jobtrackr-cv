-- 082_weekly_plan_caps_and_price_fix.sql
--
-- Two corrections to public.plans:
--
-- 1. Restore weekly plan caps (reverting 061_weekly_plan_unlimited.sql).
--    The original 051_billing.sql seed had weekly caps (50/75 CVs+letters,
--    5 profiles, 30 runs). Migration 061 removed them following the 2026-06-15
--    weekly-unlimited decision; that decision was reversed on 2026-07-22 —
--    an uncapped A$9.99 weekly plan undermines the A$29.99 Unlimited tier.
--    Note: loadLimits() in entitlements.ts reads the DB as authoritative, so
--    caps take effect for active weekly subscribers the moment this commits.
--
-- 2. Fix stale display prices for monthly and unlimited plans.
--    Seeded as 2499 / 4999 placeholders; finalized 2026-06-23 at 1999 / 2999
--    (AUD cents), already what Stripe charges and what PUBLIC_PLANS displays.

update public.plans
set
  max_profiles      = 5,
  max_runs          = 30,
  max_cv_unique     = 50,
  max_cv_total      = 75,
  max_letter_unique = 50,
  max_letter_total  = 75
where id = 'weekly';

update public.plans
set price_cents = 1999
where id = 'monthly';

update public.plans
set price_cents = 2999
where id = 'unlimited';

-- Allow "possible_duplicate" as a dedup_status value.
-- Used by the L2-weak dedup tier: title + company match but city differs
-- (multi-branch listings). UI surfaces these with a "Possible duplicate" pill
-- + Hide action.

alter table public.jobs
  drop constraint if exists jobs_dedup_status_check;

alter table public.jobs
  add constraint jobs_dedup_status_check
  check (dedup_status in ('original', 'duplicate', 'repost', 'possible_duplicate'));

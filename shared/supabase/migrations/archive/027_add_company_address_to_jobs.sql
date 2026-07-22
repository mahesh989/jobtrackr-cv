-- Add company_address field to jobs for cover letter employer block.
-- Phase 10.5 follow-up.
--
-- Multiline text (newlines preserved) so users can paste street + suburb
-- across separate lines as they appear on a real letterhead. Inserted in
-- the employer block between company name and jobs.location (city/state).

alter table public.jobs
  add column if not exists company_address text;

comment on column public.jobs.company_address is
  'Street/postal address of the employer, multi-line. Used in the cover letter '
  'employer block between company name and city/state. NULL = omit.';

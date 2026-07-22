-- Add hiring_manager field to jobs table for cover letter salutation personalization.
-- Phase 10.5: Delivery template + PDF export.

alter table public.jobs
  add column if not exists hiring_manager text;

comment on column public.jobs.hiring_manager is
  'Name of the hiring manager for this role. Used in cover letter salutation (e.g., "Dear John Smith,"). If NULL, salutation defaults to "Dear Hiring Manager,".';

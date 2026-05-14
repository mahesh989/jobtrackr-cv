-- ============================================================
-- Migration 015: per-job manual JD override + contact email
--
-- manual_jd_text: user-edited, trimmed JD text. If set, the analyse pipeline
--                 uses this in preference to the scraped jobs.description.
-- contact_email:  optional recipient address for an eventual "send tailored
--                 CV via email" flow. Manually entered for now; adapter-side
--                 auto-extraction is a later epic.
--
-- Both fields are nullable — existing rows untouched, no backfill needed.
-- ============================================================

alter table public.jobs
  add column if not exists manual_jd_text text,
  add column if not exists contact_email  text;

comment on column public.jobs.manual_jd_text is
  'User-edited JD text. When set, /api/jobs/[id]/analyze prefers this over jobs.description so the AI receives a denoised input.';

comment on column public.jobs.contact_email is
  'Optional recruiter contact for a future MCP email-send flow.';

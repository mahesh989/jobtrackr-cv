-- ============================================================
-- Migration 016: cv_versions.categorised_skills
--
-- Stores the AI categorisation of a CV's own skills, computed once at
-- upload time. Shape (when not null):
--   {
--     "technical":        [str, ...],
--     "soft_skills":      [str, ...],
--     "domain_knowledge": [str, ...]
--   }
--
-- Null while pending, or when the user has no AI key connected.
-- ============================================================

alter table public.cv_versions
  add column if not exists categorised_skills jsonb;

comment on column public.cv_versions.categorised_skills is
  'AI-extracted categorised skill list from this CV. Populated at upload when an AI key is configured; null otherwise. Used for at-a-glance review and as a possible prefill for tailoring.';

-- ============================================================
-- Migration 018: persist provider + model on each analysis_run
--
-- Stores which AI provider + exact model ID was used for the run, so the
-- analysis viewer can show "Run details" + future audit / cost analysis
-- can attribute usage correctly.
-- ============================================================

alter table public.analysis_runs
  add column if not exists ai_provider text,
  add column if not exists ai_model    text;

comment on column public.analysis_runs.ai_provider is
  'AI provider used for this run: anthropic | openai | deepseek';
comment on column public.analysis_runs.ai_model is
  'Exact model ID sent to the provider (e.g. ''gpt-5.2'', ''claude-sonnet-4-6'').';

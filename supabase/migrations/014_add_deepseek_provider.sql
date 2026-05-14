-- ============================================================
-- Migration 014: allow 'deepseek' provider on user_integrations
--
-- Extends the chk_provider constraint added in 012 to include deepseek
-- alongside anthropic and openai. cv-backend treats DeepSeek as an
-- OpenAI-compatible API (different base URL).
-- ============================================================

alter table public.user_integrations
  drop constraint chk_provider;

alter table public.user_integrations
  add constraint chk_provider
    check (provider in ('apify', 'linkedin', 'indeed', 'anthropic', 'openai', 'deepseek'));

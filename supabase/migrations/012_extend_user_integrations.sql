-- ============================================================
-- Migration 012: extend user_integrations.provider allow-list
--
-- Adds 'anthropic' and 'openai' to the existing chk_provider constraint.
-- BYOK AI keys for the CV-tailoring pipeline are stored as additional
-- user_integrations rows, reusing the same AES-256-GCM crypto helper.
--
-- Existing 'apify' rows are unaffected.
-- ============================================================

alter table public.user_integrations
  drop constraint chk_provider;

alter table public.user_integrations
  add constraint chk_provider
    check (provider in ('apify', 'linkedin', 'indeed', 'anthropic', 'openai'));

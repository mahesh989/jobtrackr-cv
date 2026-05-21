-- Migration 035 — align email_integrations.provider CHECK with code
--
-- Migration 031 set the constraint to ('gmail', 'outlook') — product names.
-- Phase F code (web/src/lib/email/*) uses ('google', 'microsoft') — OAuth
-- provider names. These didn't match, so every OAuth callback's upsert was
-- silently rejected by Postgres with a check_violation; the table stayed
-- empty and the Connect button never flipped to "Connected".
--
-- Fix: drop the old constraint and re-add with the names the code actually
-- uses. (Table is currently empty in all known environments, so no data
-- migration is needed.)

ALTER TABLE email_integrations
  DROP CONSTRAINT IF EXISTS email_integrations_provider_check;

ALTER TABLE email_integrations
  ADD  CONSTRAINT email_integrations_provider_check
       CHECK (provider IN ('google', 'microsoft'));

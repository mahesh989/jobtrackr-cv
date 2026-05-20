-- Migration 027: Phase 11 — Opening paragraph variants
--
-- Adds status='picking' and three new columns to cover_letters so the
-- variant picker flow can store and retrieve opener options.
--
-- New status value:
--   picking  → variants generated, row exists, user has not yet chosen an opener
--
-- New columns (all nullable — no backfill needed for existing completed rows):
--   opening_variants   jsonb  [{id, text, pattern_label}] — raw output from
--                             /internal/generate-opening-variants
--   chosen_opening     text   — the P1 opener text the user picked
--   discarded_openings jsonb  [{id, text, pattern_label}] — the variants NOT
--                             chosen (telemetry; future prompt-tuning signal)
--
-- ── Step 1: Widen the status CHECK constraint ─────────────────────────────────
--
-- The original CHECK was declared inline in migration 025 with no name.
-- PostgreSQL auto-names it cover_letters_status_check.
-- Both ALTER statements are safe with live rows (no table scan on DROP,
-- no rewrite on ADD CHECK for existing values).

ALTER TABLE public.cover_letters
  DROP CONSTRAINT cover_letters_status_check;

ALTER TABLE public.cover_letters
  ADD CONSTRAINT cover_letters_status_check
  CHECK (status IN ('pending', 'running', 'completed', 'failed', 'picking'));

-- ── Step 2: Add Phase 11 columns ──────────────────────────────────────────────

ALTER TABLE public.cover_letters
  ADD COLUMN IF NOT EXISTS opening_variants   jsonb DEFAULT NULL;

ALTER TABLE public.cover_letters
  ADD COLUMN IF NOT EXISTS chosen_opening     text  DEFAULT NULL;

ALTER TABLE public.cover_letters
  ADD COLUMN IF NOT EXISTS discarded_openings jsonb DEFAULT NULL;

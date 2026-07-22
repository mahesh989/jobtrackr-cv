-- Migration 034 — Phase F: email integration token storage + send tracking
--
-- 1. email_integrations.oauth_token: bytea → text
--    The web app stores AES-256-GCM encrypted JSON as a base64 string.
--    bytea would require binary round-trips; text is simpler and equally safe
--    behind RLS (only the owning user can read their row).
--
-- 2. cover_letters: add email_sent_at + email_sent_to
--    Stamped by /api/applications/[letter_id]/send-email after a successful
--    dispatch. Used by the Applications page to distinguish "letter ready"
--    from "email sent" without joining to the applications table.

-- ── 1. Change oauth_token column type ────────────────────────────────────────
ALTER TABLE email_integrations
  ALTER COLUMN oauth_token TYPE text USING null;

-- ── 2. Email send tracking on cover_letters ───────────────────────────────────
ALTER TABLE cover_letters
  ADD COLUMN IF NOT EXISTS email_sent_at  timestamptz,
  ADD COLUMN IF NOT EXISTS email_sent_to  text;

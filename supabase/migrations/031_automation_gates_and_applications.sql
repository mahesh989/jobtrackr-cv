-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 031 — automation gates + applications outbox (schema only)
--
-- Phase A of the gated-pipeline overhaul. Adds:
--   • jobs:           jd_quality, role_match, has_email (generated)
--   • analysis_runs:  initial_ats_score, passed_initial_gate,
--                     passed_final_gate, automation
--   • search_profiles: 6 automation-config columns
--   • cover_letters:  auto_selected_variant_id
--   • applications:   NEW table — the outbox (email/apply_link channels)
--   • email_integrations: NEW table — Phase F stub (schema only, no code yet)
--
-- Existing flows continue working unchanged. Every new column is either
-- NULLable, has a safe default, or is generated. No existing code reads
-- these columns yet — Phase B introduces the first readers.
--
-- pipeline_state is NOT a column. It is derived in JS (same pattern as
-- progressFlags.deriveProgress) — single source of truth, no triggers
-- needed to keep it consistent.
--
-- Companion: 032_backfill_jd_quality_and_role_match.sql fills the two
-- new jobs columns for existing rows.
-- ──────────────────────────────────────────────────────────────────────────────

-- ── jobs: pre-check signals + generated has_email flag ──────────────────────
ALTER TABLE jobs
  ADD COLUMN jd_quality  text CHECK (jd_quality IN ('rich', 'thin', 'unknown')),
  ADD COLUMN role_match  text CHECK (role_match IN ('match', 'mismatch', 'uncertain')),
  ADD COLUMN has_email   boolean GENERATED ALWAYS AS (contact_email IS NOT NULL) STORED;

-- ── analysis_runs: two-gate model + automation flag ─────────────────────────
ALTER TABLE analysis_runs
  ADD COLUMN initial_ats_score    numeric,
  ADD COLUMN passed_initial_gate  boolean,
  ADD COLUMN passed_final_gate    boolean,
  ADD COLUMN automation           boolean NOT NULL DEFAULT false;

-- ── search_profiles: per-profile automation config ──────────────────────────
ALTER TABLE search_profiles
  ADD COLUMN automation_enabled      boolean NOT NULL DEFAULT false,
  ADD COLUMN min_initial_ats         numeric NOT NULL DEFAULT 55
    CHECK (min_initial_ats >= 0 AND min_initial_ats <= 100),
  ADD COLUMN min_final_ats           numeric NOT NULL DEFAULT 75
    CHECK (min_final_ats   >= 0 AND min_final_ats   <= 100),
  ADD COLUMN role_match_strict       boolean NOT NULL DEFAULT false,
  ADD COLUMN auto_send_emails        text    NOT NULL DEFAULT 'never'
    CHECK (auto_send_emails IN ('never', 'after_review', 'auto')),
  ADD COLUMN daily_application_limit int     NOT NULL DEFAULT 10
    CHECK (daily_application_limit >= 0);

-- ── cover_letters: track AI's auto-picked hook variant (for analytics) ──────
ALTER TABLE cover_letters
  ADD COLUMN auto_selected_variant_id text;

-- ── applications: NEW — the outbox ──────────────────────────────────────────
-- One row per application attempt. Channel = 'email' (we can send) or
-- 'apply_link' (no email; user opens the job URL manually). The email
-- draft is generated for BOTH channels — the apply_link case treats it
-- as a "sample" the user can copy if they find a contact later.
CREATE TABLE applications (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  job_id          uuid        NOT NULL REFERENCES jobs(id)           ON DELETE CASCADE,
  analysis_run_id uuid                 REFERENCES analysis_runs(id)  ON DELETE SET NULL,
  cover_letter_id uuid                 REFERENCES cover_letters(id)  ON DELETE SET NULL,
  channel         text        NOT NULL CHECK (channel IN ('email', 'apply_link')),
  email_draft     text,
  email_subject   text,
  status          text        NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'pending_review', 'queued', 'sent', 'failed', 'applied', 'archived')),
  sent_at         timestamptz,
  sent_to         text,
  error_message   text,
  user_verified   boolean     NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE applications ENABLE ROW LEVEL SECURITY;

CREATE POLICY users_own_applications ON applications
  FOR ALL
  USING      (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER applications_set_updated_at
  BEFORE UPDATE ON applications
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Outbox queries: user_id + status (+ created_at for ordering within a tab)
CREATE INDEX applications_user_status_created_idx
  ON applications (user_id, status, created_at DESC);

-- Lookup of application(s) for a given job
CREATE INDEX applications_job_idx
  ON applications (job_id);

-- Realtime — UI subscribes for live "ready to send" / "sent" updates
ALTER PUBLICATION supabase_realtime ADD TABLE applications;

-- ── email_integrations: NEW — Phase F stub (schema only) ────────────────────
-- One row per user. provider + oauth_token populated during the OAuth
-- handshake we'll build in Phase F. Encryption format matches the
-- existing user_integrations pattern (AES-256-GCM via the existing
-- crypto helper).
CREATE TABLE email_integrations (
  user_id      uuid        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  provider     text        CHECK (provider IN ('gmail', 'outlook')),
  oauth_token  bytea,
  from_address text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE email_integrations ENABLE ROW LEVEL SECURITY;

CREATE POLICY users_own_email_integration ON email_integrations
  FOR ALL
  USING      (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER email_integrations_set_updated_at
  BEFORE UPDATE ON email_integrations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

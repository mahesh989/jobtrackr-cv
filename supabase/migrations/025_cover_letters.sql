-- Migration 025: cover_letters table
-- Phase 10.4 — Three-pass cover letter generation pipeline
--
-- One row per generated letter per (user_id, job_id) pair.
-- cv-backend writes via service-role key (bypasses RLS).
-- Browser subscribes via Supabase Realtime to watch generation progress.
-- All three pass outputs are stored to enable debugging and future UI.

CREATE TABLE public.cover_letters (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   uuid        NOT NULL REFERENCES public.users(id)  ON DELETE CASCADE,
  job_id                    uuid        NOT NULL REFERENCES public.jobs(id)   ON DELETE CASCADE,

  -- ── Status ────────────────────────────────────────────────────────────────
  -- pending   → row created, BackgroundTask not yet started
  -- running   → pipeline in progress; pass columns populate incrementally
  -- completed → all passes + quality gates done; pass_3_final is ready
  -- failed    → pipeline aborted; error_message populated
  status                    text        NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'running', 'completed', 'failed')),

  -- Fine-grained progress for the Realtime subscriber
  -- Each key value: 'pending' | 'running' | 'completed' | 'failed'
  generation_status         jsonb       NOT NULL DEFAULT jsonb_build_object(
                              'pass_1', 'pending',
                              'pass_2', 'pending',
                              'pass_3', 'pending',
                              'gate_1', 'pending',
                              'gate_2', 'pending',
                              'gate_3', 'pending'
                            ),

  -- ── Generation inputs captured at trigger time ────────────────────────────
  -- story_id FK is ON DELETE SET NULL — re-extraction deletes old stories, so
  -- existing cover letters lose the FK but retain the story text in pass_1_skeleton.
  story_id                  uuid        REFERENCES public.stories(id) ON DELETE SET NULL,
  company_hook_text         text,         -- selected company fact used as paragraph 1 opener
  tone_target               text        CHECK (tone_target IN ('professional', 'warm', 'direct')),
  word_count_target         int         NOT NULL DEFAULT 170,

  -- ── Pass outputs ─────────────────────────────────────────────────────────
  pass_1_skeleton           text,         -- populated after Pass 1 completes
  pass_2_voice_transferred  text,         -- populated after Pass 2 completes
  pass_3_final              text,         -- the deliverable shown to the user

  -- ── Quality gate scores ───────────────────────────────────────────────────
  burstiness_score          float,        -- stddev(sentence_lens)/mean; Gate 3 input
  naturalness_score         float,        -- burstiness normalised to [0,1] for UI badge
  coherence_score           float,        -- Gate 2 vocabulary overlap metric
  specificity_ok            boolean,      -- Gate 3: ≥1 concrete number/name/place in letter
  honesty_ok                boolean,      -- Gate 1: all claims traceable to master CV

  -- Which gates triggered retries (for future analysis of failure patterns)
  quality_flags             jsonb       NOT NULL DEFAULT '{}'::jsonb,

  -- ── AI provenance ─────────────────────────────────────────────────────────
  ai_provider               text        NOT NULL CHECK (ai_provider IN ('anthropic', 'openai', 'deepseek')),
  -- Actual models used — may differ from user's preferred model per D4
  pass_1_model              text,
  pass_2_model              text,
  pass_3_model              text,

  -- ── User edit capture (Part 8 — feedback loop, deferred) ─────────────────
  user_edits                text,
  edit_diff                 jsonb,

  -- ── Outcome tracking (Part 8, deferred) ──────────────────────────────────
  outcome                   text        CHECK (outcome IN ('draft', 'sent', 'replied', 'interview', 'rejected', 'hired')),

  -- ── Error details ─────────────────────────────────────────────────────────
  error_message             text,

  -- ── Lifecycle ─────────────────────────────────────────────────────────────
  is_stale                  boolean     NOT NULL DEFAULT false,
  started_at                timestamptz,
  completed_at              timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

-- Fast lookup: current non-stale letter for a (user, job) pair
CREATE INDEX cover_letters_user_job_idx
  ON public.cover_letters(user_id, job_id, created_at DESC)
  WHERE is_stale = false;

CREATE INDEX cover_letters_user_id_idx
  ON public.cover_letters(user_id);

-- Helps cv-backend quickly check for stuck pending/running rows
CREATE INDEX cover_letters_status_idx
  ON public.cover_letters(status)
  WHERE status IN ('pending', 'running');

-- Updated-at trigger (set_updated_at defined in 001_schema.sql)
CREATE TRIGGER cover_letters_updated_at
  BEFORE UPDATE ON public.cover_letters
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS: users own their own letters
ALTER TABLE public.cover_letters ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_own_cover_letters"
  ON public.cover_letters
  FOR ALL
  USING     (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Realtime: browser subscribes to row changes to track generation progress
-- Adding a new table does not affect existing analysis_runs subscriptions —
-- each subscription filters by table name independently.
ALTER PUBLICATION supabase_realtime ADD TABLE public.cover_letters;

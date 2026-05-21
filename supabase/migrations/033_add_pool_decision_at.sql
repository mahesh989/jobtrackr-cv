-- Migration 033 — Applications pool decision tracking
--
-- Adds pool_decision_at to jobs so the outbox can distinguish:
--   NULL  → cover letter exists but user hasn't decided the channel yet (Pool tab)
--   value → user decided: if contact_email IS NOT NULL → Ready to email
--                         if contact_email IS NULL     → Ready to apply (manual)

ALTER TABLE jobs
  ADD COLUMN pool_decision_at timestamptz DEFAULT NULL;

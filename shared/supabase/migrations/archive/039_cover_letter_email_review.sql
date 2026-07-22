-- Migration 039: review-then-send for outgoing application emails.
--
-- Splits the "Ready to email" stage into two:
--   • Review stage  — pool_decision_at SET, contact_email present, reviewed_at NULL
--                     (lives in the "Ready to email" tab)
--   • Send stage    — pool_decision_at SET, contact_email present, reviewed_at SET
--                     (lives in the "Ready to apply" tab alongside no-email jobs)
--
-- The user clicks "Review" on a card in "Ready to email", reviews/edits the
-- subject + body in the compose modal, then clicks "Approve" — at that point
-- the modal POSTs the (possibly edited) subject + body and we stamp
-- reviewed_at = now(). The card then surfaces in "Ready to apply" with a
-- "Send email" button that dispatches without re-opening the compose modal.
--
-- Stored email_subject/email_body let /send-email use the user-approved
-- content even though Send happens from a different button without a fresh
-- review pass.
--
-- All three columns are nullable so existing rows continue to work
-- (untouched rows are NULL → not yet reviewed, so they fall back to the
-- review stage on the next refresh — exactly the intended behaviour).

ALTER TABLE cover_letters
  ADD COLUMN IF NOT EXISTS reviewed_at   timestamptz,
  ADD COLUMN IF NOT EXISTS email_subject text,
  ADD COLUMN IF NOT EXISTS email_body    text;

-- Index for the bucket query in /dashboard/applications which filters cards
-- by (user_id, status='completed') and then partitions on reviewed_at.
CREATE INDEX IF NOT EXISTS cover_letters_user_status_reviewed_idx
  ON cover_letters (user_id, status, reviewed_at);

COMMENT ON COLUMN cover_letters.reviewed_at IS
  'When the user clicked Approve in the compose modal. NULL = still in the Review stage; SET = ready to send. Cleared if the letter is regenerated or edited (so any revision goes back through review).';
COMMENT ON COLUMN cover_letters.email_subject IS
  'Subject line approved by the user during review. /send-email uses this if set, otherwise computes from buildDefaultEmailDraft.';
COMMENT ON COLUMN cover_letters.email_body IS
  'Email body approved by the user during review. /send-email uses this if set, otherwise computes from buildDefaultEmailDraft.';

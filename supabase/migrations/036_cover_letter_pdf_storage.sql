-- Migration 036 — Phase G: Cover Letter PDF persistence
--
-- Until now cover letters lived only as text (pass_3_final) and were rendered
-- to PDF on demand via client-side jsPDF in CoverLetterPanel. That meant:
--   - No PDF to attach to outgoing emails (Phase F send-email only attached
--     the tailored CV PDF, not the cover letter).
--   - No re-downloadable record of "what was sent" — each download was a
--     fresh client-side render.
--
-- Phase G generates and stores the cover letter PDF server-side once the
-- letter completes (or lazy-on-first-request), so it can be attached to
-- emails AND downloaded later from anywhere.
--
-- 1. cover_letters.pdf_storage_path — Storage path inside cover-letters bucket
--    Convention: {user_id}/{letter_id}.pdf
-- 2. NEW bucket: cover-letters — same RLS pattern as tailored-cvs (folder-1 = user_id)
--    PDF-only, 5 MB cap (cover letters are 1-2 pages → ~50-100 KB typical)

-- ── 1. Column on cover_letters ───────────────────────────────────────────────
ALTER TABLE cover_letters
  ADD COLUMN IF NOT EXISTS pdf_storage_path text;

-- ── 2. Storage bucket ────────────────────────────────────────────────────────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'cover-letters',
  'cover-letters',
  false,
  5 * 1024 * 1024,                  -- 5 MB cap
  ARRAY['application/pdf']
)
ON CONFLICT (id) DO UPDATE SET
  file_size_limit    = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types,
  public             = excluded.public;

-- ── 3. RLS — owner-only access scoped by first folder segment ───────────────
-- Web writes via service-role (bypasses RLS); these policies govern browser
-- download access.

DROP POLICY IF EXISTS "cover_letters_owner_select" ON storage.objects;

CREATE POLICY "cover_letters_owner_select"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'cover-letters' AND auth.uid()::text = (storage.foldername(name))[1]);

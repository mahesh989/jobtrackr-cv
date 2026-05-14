-- ============================================================
-- Migration 019: tailored-cvs bucket must allow text/markdown
--
-- Phase 6 step 6 uploads the tailored CV as markdown (.md, text/markdown)
-- before Phase 7 renders the PDF. The bucket was created PDF-only in
-- migration 013, so uploads failed with HTTP 415 invalid_mime_type.
--
-- Widen the allow-list to include both. Existing PDF uploads continue
-- to work.
-- ============================================================

update storage.buckets
set allowed_mime_types = array['application/pdf', 'text/markdown']
where id = 'tailored-cvs';

-- 056_cv_extracted_references.sql
-- Adds a per-CV cache of references extracted from the uploaded CV text.
--
-- Why per-CV (not user_preferences): the user's saved references in
-- user_preferences.contact_details.references is curated/authoritative.
-- We never overwrite it during upload. Instead we cache what the AI found in
-- the uploaded CV here, and the UI offers a "use these" button so the user
-- explicitly opts in before it lands in their saved settings.
--
-- Shape (JSONB array, may be empty):
--   [
--     {"name": "...", "job_title": "...", "company": "...", "email": "..."},
--     ...
--   ]
-- All four fields are optional strings. NULL means "extraction not yet run".

ALTER TABLE cv_versions
  ADD COLUMN IF NOT EXISTS extracted_references JSONB;

COMMENT ON COLUMN cv_versions.extracted_references IS
  'AI-extracted referee list from the original CV. NULL = not yet extracted. [] = extracted but none found.';

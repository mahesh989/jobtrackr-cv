-- 059_cv_versions_normalized_cv_text.sql
-- The canonical CV text that the analysis pipeline reads. Re-rendered from
-- structured_cv every time the user saves the review form, so the pipeline
-- always sees the same consistent skeleton (same section order, same heading
-- labels, same date format) regardless of how the original CV was laid out.
--
-- analyze route precedence:
--   normalized_cv_text  (preferred — verified + tidy)
--   cv_text             (fallback — legacy/un-reviewed CVs)

ALTER TABLE cv_versions
  ADD COLUMN IF NOT EXISTS normalized_cv_text TEXT;

COMMENT ON COLUMN cv_versions.normalized_cv_text IS
  'Canonical CV markdown rendered from structured_cv on every save. Source of truth for analysis. NULL = not yet structured (legacy or pre-review).';

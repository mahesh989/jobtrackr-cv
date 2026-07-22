-- 058_cv_versions_structured_cv.sql
-- Adds a normalised, user-verifiable structured representation of the source
-- CV. This becomes the single source of truth the analysis pipeline reads
-- from (Phase 3) — replacing ad-hoc parsing of the raw cv_text — so that every
-- candidate's CV passes through the same schema, same sections, same gap
-- checks, and the tailored output is consistent across thousands of CVs.
--
-- structured_cv shape (JSONB; see app/services/cv/cv_structurizer.py):
--   {
--     "contact":        {"name","email","phone","location","links":[...]},
--     "summary":        "...",
--     "experience":     [{"employer","role","location","start_date","end_date",
--                         "is_current",bool,"bullets":[...],"vertical_hint":"..."}],
--     "education":      [{"institution","qualification","location",
--                         "start_date","end_date","completed":bool}],
--     "certifications": [{"name","issuer","code","issued_date"}],
--     "skills":         {"technical":[...],"soft_skills":[...],"domain_knowledge":[...]},
--     "references":     [{"name","job_title","company","email"}],
--     "gaps":           [{"section","entry_index","field","message"}]
--   }
-- All dates are VERBATIM strings copied from the CV (e.g. "Dec 2025 – Feb 2026",
-- "Completed 2021") or "" when absent — never inferred. The `gaps` array is the
-- deterministic list of missing/incomplete fields the review form surfaces.
--
-- structured_cv_status lifecycle:
--   NULL      → not yet structured (legacy CVs uploaded before this feature)
--   'parsed'  → AI parse stored, user has not reviewed
--   'edited'  → user has made at least one edit in the review form
--   'verified'→ user explicitly confirmed the CV is correct

ALTER TABLE cv_versions
  ADD COLUMN IF NOT EXISTS structured_cv        JSONB,
  ADD COLUMN IF NOT EXISTS structured_cv_status TEXT;

COMMENT ON COLUMN cv_versions.structured_cv IS
  'Normalised, user-verifiable structured CV — the analysis source of truth. NULL = not yet parsed. See app/services/cv/cv_structurizer.py for the schema.';
COMMENT ON COLUMN cv_versions.structured_cv_status IS
  'parsed | edited | verified — NULL for legacy CVs predating the structured-CV feature.';

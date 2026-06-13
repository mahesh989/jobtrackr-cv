-- Migration 024: company_research table
-- Phase 10.3 — Company Research Pipeline
--
-- Global shared cache: one row per company, reused across all users.
-- No user_id column — RLS uses auth.role() = 'authenticated' (not UID-scoped).
-- company_id is a normalised text slug (e.g. 'jll_australia'), not a UUID.
-- cv-backend writes via service-role key (bypasses RLS).
-- TTL refresh: last_researched_at checked by web route; stale = > research_ttl_days old.

CREATE TABLE public.company_research (
  company_id             text        PRIMARY KEY,           -- normalised slug, e.g. 'jll_australia'
  name                   text        NOT NULL,              -- display name as provided at trigger time
  domain                 text,                              -- nullable; discovered during first research
  facts                  jsonb       NOT NULL,              -- CompanyFacts object
  voice_signals          jsonb       NOT NULL,              -- VoiceSignals object
  hiring_intel           jsonb       NOT NULL,              -- HiringIntel object
  research_quality_score float       NOT NULL DEFAULT 0.0, -- deterministic 0.0–1.0; see quality_scorer.py
  search_skipped         boolean     NOT NULL DEFAULT false,-- true when TAVILY_API_KEY absent/failed
  last_researched_at     timestamptz NOT NULL,
  research_ttl_days      int         NOT NULL DEFAULT 90,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- TTL refresh queries: find rows where last_researched_at < now() - research_ttl_days days
CREATE INDEX company_research_last_researched_idx
  ON public.company_research(last_researched_at);

-- Future domain-based dedup lookup (domain known after first research)
CREATE INDEX company_research_domain_idx
  ON public.company_research(domain)
  WHERE domain IS NOT NULL;

-- Updated_at trigger (set_updated_at defined in 001_schema.sql)
CREATE TRIGGER company_research_updated_at
  BEFORE UPDATE ON public.company_research
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS: all authenticated users can read (global cache, not user-scoped)
ALTER TABLE public.company_research ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated_read_company_research"
  ON public.company_research
  FOR SELECT
  USING (auth.role() = 'authenticated');

-- No INSERT/UPDATE/DELETE policy: service-role key bypasses RLS for cv-backend writes.
-- Browsers have no write access to this table.

-- ============================================================
-- Migration 053: jobs.starred_at — favourites/shortlist
--
-- Lets the user star jobs while browsing to build a personal shortlist.
-- NULL = not starred (default). Set/unset via bulkStarJobs / bulkUnstarJobs
-- in web/src/lib/actions.ts.
--
-- Why a timestamp not a boolean: gives us free sort-by-recently-starred
-- ordering without an extra column. Matches the dismissed_at / applied_at
-- pattern already used on this table.
-- ============================================================

alter table public.jobs
  add column if not exists starred_at timestamptz;

comment on column public.jobs.starred_at is
  'When the user starred this job (NULL = not starred). Used for the favourites filter chip.';

-- Partial index over starred rows only — keeps the index tiny and makes the
-- "Starred" filter query fast even when the user has thousands of jobs.
create index if not exists idx_jobs_starred
  on public.jobs(profile_id, starred_at desc)
  where starred_at is not null;

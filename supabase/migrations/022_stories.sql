-- ============================================================
-- Migration 022: stories (cover letter — Phase 10.2.a, story extraction)
--
-- One row per story per user. Multiple rows per user_id (no UNIQUE).
-- Atomic overwrite on re-extraction: the web API route deletes all rows
-- for user_id then inserts the new batch in a single operation.
--
-- extraction_timestamp has NO DEFAULT — cv-backend sets it explicitly so
-- all rows in a batch share the exact same value. A missing timestamp is
-- caught at INSERT time (NOT NULL violation) rather than silently
-- corrupting the Phase 10.2.b batch-identification query pattern.
--
-- cv_text is never stored here. numbers and tags columns are sized for
-- Phase 10.2.b story-to-JD matching without breaking-change migrations.
--
-- cv-backend writes via service-role key (bypasses RLS). Browser reads
-- its own rows via auth.uid() = user_id RLS policy.
-- ============================================================

create table public.stories (
  id                   uuid        primary key default gen_random_uuid(),
  user_id              uuid        not null references public.users(id) on delete cascade,
  title                text        not null,
  domain               text        not null,
  year                 integer,
  one_line             text        not null,
  detailed             text        not null,
  numbers              jsonb       not null default '[]'::jsonb,
  tags                 text[]      not null default '{}',
  extraction_timestamp timestamptz not null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- Composite index on (user_id, extraction_timestamp DESC).
-- Satisfies three Phase 10.2.b query patterns without a redundant
-- single-column user_id index:
--   1. "All stories for user X"     → user_id prefix scan
--   2. "Most recent batch"          → pre-sorted DESC, no sort step
--   3. "Batch WHERE ts = MAX(ts)"   → equality on both columns
create index stories_user_id_extraction_ts_idx
  on public.stories (user_id, extraction_timestamp desc);

-- updated_at trigger — set_updated_at() defined in 001_schema.sql
create trigger stories_updated_at
  before update on public.stories
  for each row execute function public.set_updated_at();

-- RLS — users see and touch only their own rows.
-- cv-backend writes bypass RLS via service-role key (established pattern).
alter table public.stories enable row level security;

create policy "users_own_stories"
  on public.stories
  for all
  using     (auth.uid() = user_id)
  with check (auth.uid() = user_id);

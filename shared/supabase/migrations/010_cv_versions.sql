-- ============================================================
-- Migration 010: cv_versions
--
-- User-uploaded CVs with versioning. Exactly one row per user can have
-- is_active = true at any time, enforced by a partial unique index.
--
-- PDF stored in Supabase Storage at: cvs/{user_id}/{cv_version_id}.pdf
-- cv_text is the plain-text extraction (done in cv-backend via pypdf).
-- ============================================================

create table public.cv_versions (
  id                  uuid        primary key default gen_random_uuid(),
  user_id             uuid        not null references public.users(id) on delete cascade,

  label               text        not null,                -- e.g. "Master CV — 2026"
  pdf_storage_path    text        not null,                -- Supabase Storage path
  cv_text             text        not null,                -- pypdf extraction

  is_active           boolean     not null default false,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- Exactly one active CV per user
create unique index uq_one_active_cv_per_user
  on public.cv_versions(user_id)
  where is_active = true;

create index idx_cv_versions_user_id on public.cv_versions(user_id);
create index idx_cv_versions_created_at on public.cv_versions(created_at desc);

-- Auto-update updated_at (function defined in earlier migration)
create trigger cv_versions_updated_at
  before update on public.cv_versions
  for each row execute function public.set_updated_at();

-- ── RLS ───────────────────────────────────────────────────────────────────────
alter table public.cv_versions enable row level security;

create policy "users_own_cv_versions"
  on public.cv_versions
  for all
  using     (auth.uid() = user_id)
  with check (auth.uid() = user_id);

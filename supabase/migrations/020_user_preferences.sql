-- ============================================================
-- Migration 020: user_preferences (contact details + portfolio projects)
--
-- Mirrors cv-magic's user_preferences.contact_details — a single JSONB blob
-- with these keys:
--   name, phone, email, address, linkedin, github, website,
--   portfolio (single URL), other_label, other_url,
--   projects: [ { name, url, description }, ... ]
--
-- contact_details is stamped onto the tailored CV's contact line by
-- stamp_contact_line(). Projects are appended to the CV text at analyze
-- time so the tailoring AI sees them even if they're not in the uploaded
-- PDF/DOCX.
-- ============================================================

create table public.user_preferences (
  id              uuid        primary key default gen_random_uuid(),
  user_id         uuid        not null unique references public.users(id) on delete cascade,
  contact_details jsonb,                            -- nullable; empty = nothing to stamp
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create trigger user_preferences_updated_at
  before update on public.user_preferences
  for each row execute function public.set_updated_at();

-- RLS — users only see/touch their own row
alter table public.user_preferences enable row level security;

create policy "users_own_preferences"
  on public.user_preferences
  for all
  using     (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Per-user "last viewed the Applications outbox" timestamp.
--
-- Drives the sidebar Applications badge: it counts only pool items (completed,
-- non-stale cover letters whose job is still undecided) that arrived AFTER the
-- user last opened /dashboard/applications. Visiting the page stamps this to
-- now(), so the badge clears and stays cleared until a NEW cover letter
-- completes. NULL = never visited, so every pool item counts as new.

alter table public.users
  add column if not exists applications_seen_at timestamptz;

comment on column public.users.applications_seen_at is
  'When the user last opened the Applications outbox. The sidebar badge counts only pool items whose cover letter completed after this time. NULL = never visited.';

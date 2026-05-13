-- ============================================================
-- Migration 013: Storage buckets + RLS for CV PDFs/DOCX
--
-- Buckets created here:
--   cvs           — uploaded CVs (PDF/DOCX), 5 MB cap, MIME-allowlisted
--   tailored-cvs  — pipeline-generated tailored PDFs (created by cv-backend)
--
-- Path convention inside both buckets:  {user_id}/{cv_or_run_id}.{ext}
-- RLS policies use the first path segment to scope access to the owner.
--
-- Re-running this migration is safe: every CREATE uses ON CONFLICT/IF NOT EXISTS.
-- ============================================================

-- ── Buckets ───────────────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'cvs',
  'cvs',
  false,
  5 * 1024 * 1024,                  -- 5 MB cap
  array[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]
)
on conflict (id) do update set
  file_size_limit    = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types,
  public             = excluded.public;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'tailored-cvs',
  'tailored-cvs',
  false,
  10 * 1024 * 1024,                 -- 10 MB cap (generated PDFs can be large)
  array['application/pdf']
)
on conflict (id) do update set
  file_size_limit    = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types,
  public             = excluded.public;

-- ── RLS policies — users can read/write only objects under their own folder ──
-- storage.foldername(name) splits the path; element [1] is the first segment.
-- We require that segment == auth.uid() (as text).

drop policy if exists "cvs_owner_select"  on storage.objects;
drop policy if exists "cvs_owner_insert"  on storage.objects;
drop policy if exists "cvs_owner_update"  on storage.objects;
drop policy if exists "cvs_owner_delete"  on storage.objects;

create policy "cvs_owner_select"
  on storage.objects for select
  using (bucket_id = 'cvs' and auth.uid()::text = (storage.foldername(name))[1]);

create policy "cvs_owner_insert"
  on storage.objects for insert
  with check (bucket_id = 'cvs' and auth.uid()::text = (storage.foldername(name))[1]);

create policy "cvs_owner_update"
  on storage.objects for update
  using (bucket_id = 'cvs' and auth.uid()::text = (storage.foldername(name))[1]);

create policy "cvs_owner_delete"
  on storage.objects for delete
  using (bucket_id = 'cvs' and auth.uid()::text = (storage.foldername(name))[1]);

-- Tailored-CV bucket — same policies. cv-backend writes via service-role
-- (bypasses RLS); these policies only govern browser access for downloads.
drop policy if exists "tailored_cvs_owner_select" on storage.objects;

create policy "tailored_cvs_owner_select"
  on storage.objects for select
  using (bucket_id = 'tailored-cvs' and auth.uid()::text = (storage.foldername(name))[1]);

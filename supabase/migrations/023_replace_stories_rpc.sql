-- ============================================================
-- Migration 023: replace_stories RPC (cover letter — Phase 10.2.b)
--
-- Wraps the DELETE + INSERT pattern used in Phase 10.2.a inside a single
-- plpgsql transaction, eliminating the DELETE-INSERT gap documented in
-- web/src/app/api/user/stories/extract/route.ts (TODO Phase 10.2.b comment).
--
-- Before this migration the web route issued two separate Supabase calls:
--   1. admin.from("stories").delete().eq("user_id", ...)
--   2. admin.from("stories").insert(rows)
-- A failure between the two left the user with 0 stories. Now both steps
-- are atomic: either both succeed or the delete is rolled back.
--
-- Called by the web layer (service-role):
--   admin.rpc("replace_stories", { p_user_id: userId, p_rows: rows })
--   where rows is the JSON-serialised story array (extraction_timestamp
--   already set by cv-backend; id is omitted — gen_random_uuid() fires).
--
-- SECURITY DEFINER: executes as the function owner (postgres), consistent
-- with service-role writes throughout this project. The caller (Next.js
-- route handler) has already verified the Supabase session before calling.
-- ============================================================

create or replace function public.replace_stories(
  p_user_id uuid,
  p_rows    jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Step 1: delete the entire current batch for this user.
  -- On failure the transaction rolls back and no data is lost.
  delete from public.stories
  where user_id = p_user_id;

  -- Step 2: insert the new batch.
  -- id, created_at, updated_at are omitted — they default via gen_random_uuid()
  -- and now(). user_id is supplied explicitly for every row.
  -- numbers and tags fall back to their NOT NULL defaults when the JSON field
  -- is absent or non-array (defensive; cv-backend always provides both).
  insert into public.stories (
    user_id,
    title,
    domain,
    year,
    one_line,
    detailed,
    numbers,
    tags,
    extraction_timestamp
  )
  select
    p_user_id,
    (elem->>'title')::text,
    (elem->>'domain')::text,
    (elem->>'year')::integer,
    (elem->>'one_line')::text,
    (elem->>'detailed')::text,
    case
      when jsonb_typeof(elem->'numbers') = 'array' then elem->'numbers'
      else '[]'::jsonb
    end,
    case
      when jsonb_typeof(elem->'tags') = 'array'
      then array(select jsonb_array_elements_text(elem->'tags'))
      else '{}'::text[]
    end,
    (elem->>'extraction_timestamp')::timestamptz
  from jsonb_array_elements(p_rows) as elem;
end;
$$;

-- Revoke broad execute; only service_role (used by the Next.js admin client)
-- should be able to call this function. anon and authenticated roles must not.
revoke execute on function public.replace_stories(uuid, jsonb) from public;
grant  execute on function public.replace_stories(uuid, jsonb) to service_role;

-- Reserve manual-run quota idempotently by the browser request UUID.
--
-- A BullMQ add can succeed in Redis while its acknowledgement is lost. The
-- caller must therefore retry the same request without consuming a second
-- quota event. Keep that request key in its own namespace: usage_events.ref_id
-- already belongs to analysis/cover-letter artifact triggers.
create table if not exists public.run_usage_requests (
  user_id        uuid not null references public.users(id) on delete cascade,
  request_id     uuid not null,
  profile_id     uuid not null references public.search_profiles(id) on delete cascade,
  full_refresh   boolean not null,
  usage_event_id uuid not null references public.usage_events(id) on delete cascade,
  created_at     timestamptz not null default now(),
  primary key (user_id, request_id),
  unique (usage_event_id)
);

alter table public.run_usage_requests enable row level security;
revoke all on table public.run_usage_requests from public, anon, authenticated;
grant select, insert, update, delete on table public.run_usage_requests to service_role;

create or replace function public.reserve_run_usage(
  p_user         uuid,
  p_request      uuid,
  p_profile      uuid,
  p_full_refresh boolean,
  p_max_total    int,
  p_period_start timestamptz
)
returns table(allowed boolean, reason text, event_id uuid)
language plpgsql
security definer set search_path = public
as $$
declare
  v_existing uuid;
  v_existing_status text;
  v_profile uuid;
  v_full_refresh boolean;
  v_result record;
begin
  -- Same lock used by consume_usage(). This makes lookup+reserve atomic for
  -- concurrent retries carrying the same request UUID.
  perform 1 from public.subscriptions where user_id = p_user for update;

  select r.profile_id, r.full_refresh, e.id, e.status
    into v_profile, v_full_refresh, v_existing, v_existing_status
  from public.run_usage_requests r
  join public.usage_events e on e.id = r.usage_event_id
  where r.user_id = p_user
    and r.request_id = p_request
    and e.user_id = p_user
    and e.kind = 'run'
  limit 1;

  if v_existing is not null then
    if v_profile <> p_profile or v_full_refresh <> p_full_refresh then
      return query select false, 'request_conflict'::text, null::uuid;
      return;
    end if;
    if v_existing_status = 'committed' then
      return query select true, 'existing_committed'::text, v_existing;
      return;
    end if;
    if v_existing_status = 'pending' and exists (
      select 1 from public.usage_events
       where id = v_existing and created_at > now() - interval '1 hour'
    ) then
      return query select true, 'existing_pending'::text, v_existing;
      return;
    end if;
  end if;

  select * into v_result
  from public.consume_usage(
    p_user,
    'run',
    null,
    null,
    p_max_total,
    p_period_start
  );

  if not coalesce(v_result.allowed, false) then
    return query select false, coalesce(v_result.reason, 'error')::text, null::uuid;
    return;
  end if;

  insert into public.run_usage_requests (
    user_id, request_id, profile_id, full_refresh, usage_event_id
  )
  values (p_user, p_request, p_profile, p_full_refresh, v_result.event_id)
  on conflict (user_id, request_id) do update
    set profile_id = excluded.profile_id,
        full_refresh = excluded.full_refresh,
        usage_event_id = excluded.usage_event_id,
        created_at = now();

  return query select true, 'ok'::text, v_result.event_id;
end;
$$;

revoke execute on function public.reserve_run_usage(uuid, uuid, uuid, boolean, int, timestamptz)
  from public, anon, authenticated;
grant execute on function public.reserve_run_usage(uuid, uuid, uuid, boolean, int, timestamptz)
  to service_role;

-- Commit is idempotent, kind-scoped, and reports false if the event was
-- voided/missing instead of treating a zero-row update as success.
create or replace function public.commit_run_usage(p_event uuid)
returns boolean
language plpgsql
security definer set search_path = public
as $$
declare
  v_id uuid;
begin
  update public.usage_events
     set status = 'committed'
   where id = p_event
     and kind = 'run'
     and status = 'pending'
  returning id into v_id;

  if v_id is not null then
    return true;
  end if;

  return exists (
    select 1 from public.usage_events
     where id = p_event and kind = 'run' and status = 'committed'
  );
end;
$$;

revoke execute on function public.commit_run_usage(uuid)
  from public, anon, authenticated;
grant execute on function public.commit_run_usage(uuid) to service_role;

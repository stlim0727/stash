create extension if not exists pg_cron;

create table if not exists public.anon_user_cleanup_log (
  id                uuid primary key default gen_random_uuid(),
  run_at            timestamptz not null default now(),
  deleted_count     int not null,
  deleted_ids       uuid[] not null default '{}',
  predicate_version text not null
);

alter table public.anon_user_cleanup_log enable row level security;

create or replace function public.cleanup_anonymous_users()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_predicate_version constant text := 'tier-a-v2';
  v_deleted_ids uuid[];
  v_deleted_count int;
begin
  with eligible as (
    select u.id
    from auth.users u
    where u.is_anonymous = true
      and not exists (select 1 from auth.identities i where i.user_id = u.id)
      and (u.email is null or u.email = '')
      and not exists (select 1 from public.bookmarks b where b.user_id = u.id)
      and not exists (select 1 from public.collections c where c.user_id = u.id)
      and not exists (select 1 from public.tags t where t.user_id = u.id)
      and not exists (select 1 from public.feedback_reports f where f.user_id = u.id)
      and not exists (select 1 from public.api_keys k where k.user_id = u.id)
      and coalesce(u.last_sign_in_at, u.created_at) < now() - interval '7 days'
      and not exists (
        select 1 from auth.sessions s
        where s.user_id = u.id
          and s.updated_at > now() - interval '7 days'
      )
    order by coalesce(u.last_sign_in_at, u.created_at) asc
    limit 500
  ),
  deleted as (
    delete from auth.users u
    using eligible e
    where u.id = e.id
    returning u.id
  )
  select coalesce(array_agg(d.id), '{}'::uuid[]), count(*)::int
    into v_deleted_ids, v_deleted_count
  from deleted d;

  insert into public.anon_user_cleanup_log (deleted_count, deleted_ids, predicate_version)
  values (v_deleted_count, v_deleted_ids, v_predicate_version);

  return v_deleted_count;
end;
$$;

revoke all on function public.cleanup_anonymous_users() from public;
revoke all on function public.cleanup_anonymous_users() from anon;
revoke all on function public.cleanup_anonymous_users() from authenticated;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'anon-user-cleanup-daily') then
    perform cron.unschedule('anon-user-cleanup-daily');
  end if;
  perform cron.schedule(
    'anon-user-cleanup-daily',
    '17 0 * * *',
    $cron$ select public.cleanup_anonymous_users(); $cron$
  );
end;
$$;

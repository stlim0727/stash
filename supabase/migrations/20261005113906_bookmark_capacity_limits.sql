-- Starts disabled: configure measured account/project limits before enabling.
-- Counts all bookmark rows, including trash. Permanent deletion releases space.
-- Serialize writes while seeding the ledger; retain every existing bookmark.
lock table public.bookmarks in share row exclusive mode;

create table public.bookmark_capacity_limits (
  id boolean primary key default true check (id),
  enabled boolean not null default false,
  anonymous_limit bigint check (anonymous_limit > 0),
  registered_limit bigint check (registered_limit > 0),
  project_limit bigint check (project_limit > 0),
  bookmark_count bigint not null default 0 check (bookmark_count >= 0),
  constraint enabled_requires_limits check (
    not enabled or (anonymous_limit is not null and registered_limit is not null and project_limit is not null)
  )
);
create table public.bookmark_capacity_usage (
  user_id uuid primary key references auth.users(id) on delete cascade,
  bookmark_count bigint not null check (bookmark_count >= 0)
);
alter table public.bookmark_capacity_limits enable row level security;
alter table public.bookmark_capacity_usage enable row level security;
revoke all on public.bookmark_capacity_limits, public.bookmark_capacity_usage from public, anon, authenticated;
grant select, update on public.bookmark_capacity_limits to service_role;
grant select on public.bookmark_capacity_usage to service_role;
insert into public.bookmark_capacity_limits(id, bookmark_count)
select true, count(*) from public.bookmarks;
insert into public.bookmark_capacity_usage(user_id, bookmark_count)
select user_id, count(*) from public.bookmarks group by user_id;

create function public.enforce_bookmark_capacity()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  limits public.bookmark_capacity_limits%rowtype;
  used bigint;
  account_limit bigint;
  anonymous boolean;
begin
  -- No count delta for editing an existing row, even over a newly lowered cap.
  if tg_op = 'UPDATE' and new.user_id = old.user_id then return new; end if;
  -- All transactions acquire the project row first. Counter updates see the
  -- latest locked row, rather than a stale count(*) under READ COMMITTED.
  select * into limits from public.bookmark_capacity_limits where id for update;
  if not found then
    if tg_op = 'DELETE' then return old; end if;
    raise exception using errcode = 'PT503', message = 'bookmark_capacity_unavailable';
  end if;
  if tg_op in ('DELETE', 'UPDATE') then
    update public.bookmark_capacity_usage set bookmark_count = bookmark_count - 1
      where user_id = old.user_id;
    update public.bookmark_capacity_limits set bookmark_count = bookmark_count - 1 where id;
    limits.bookmark_count := limits.bookmark_count - 1;
  end if;
  if tg_op = 'DELETE' then return old; end if;

  select coalesce(u.is_anonymous, true) into anonymous from auth.users u where u.id = new.user_id;
  account_limit := case when coalesce(anonymous, true) then limits.anonymous_limit else limits.registered_limit end;
  insert into public.bookmark_capacity_usage(user_id, bookmark_count) values (new.user_id, 0)
    on conflict (user_id) do nothing;
  select bookmark_count into used from public.bookmark_capacity_usage where user_id = new.user_id for update;
  if limits.enabled and (used >= account_limit or limits.bookmark_count >= limits.project_limit) then
    raise exception using errcode = 'PT429', message = 'bookmark_capacity_limit';
  end if;
  update public.bookmark_capacity_usage set bookmark_count = bookmark_count + 1 where user_id = new.user_id;
  update public.bookmark_capacity_limits set bookmark_count = bookmark_count + 1 where id;
  return new;
end;
$$;
revoke all on function public.enforce_bookmark_capacity() from public, anon, authenticated;
-- AFTER sees the final row, including changes from existing BEFORE triggers.
create trigger enforce_bookmark_capacity
after insert or update or delete on public.bookmarks
for each row execute function public.enforce_bookmark_capacity();

create function public.get_bookmark_capacity()
returns jsonb language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'enabled', l.enabled,
    'used', coalesce(c.bookmark_count, 0),
    'limit', case when coalesce(u.is_anonymous, true) then l.anonymous_limit else l.registered_limit end
  )
  from public.bookmark_capacity_limits l
  join auth.users u on u.id = auth.uid()
  left join public.bookmark_capacity_usage c on c.user_id = u.id
  where l.id;
$$;
revoke all on function public.get_bookmark_capacity() from public, anon, authenticated;
grant execute on function public.get_bookmark_capacity() to authenticated, service_role;

begin;
insert into auth.users(id,is_anonymous) values
  ('00000000-0000-4000-8000-000000000021',true),
  ('00000000-0000-4000-8000-000000000022',false);
update public.bookmark_capacity_limits set enabled=true, anonymous_limit=1, registered_limit=2, project_limit=3;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000021',true);
set local role authenticated;
insert into public.bookmarks(user_id,title) values ('00000000-0000-4000-8000-000000000021','first');
do $$
begin
  begin
    insert into public.bookmarks(user_id,title) values ('00000000-0000-4000-8000-000000000021','over quota');
    raise exception 'FAIL: anonymous cap bypassed';
  exception when sqlstate 'PT429' then null; end;
  begin
    update public.bookmark_capacity_usage set bookmark_count=0;
    raise exception 'FAIL: client can reset usage';
  exception when insufficient_privilege then null; end;
  if public.get_bookmark_capacity()->>'used' <> '1' then raise exception 'FAIL: self usage incorrect'; end if;
end $$;
update public.bookmarks set title='edit still works',is_archived=true;
do $$
begin
  begin
    insert into public.bookmarks(user_id,title) values ('00000000-0000-4000-8000-000000000021','trash bypass');
    raise exception 'FAIL: archived row released quota';
  exception when sqlstate 'PT429' then null; end;
end $$;
delete from public.bookmarks;
insert into public.bookmarks(user_id,title) values ('00000000-0000-4000-8000-000000000021','after delete');
reset role;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000022',true);
set local role authenticated;
-- A bulk request exceeding the cap rolls back all of its rows and counters.
do $$
begin
  begin
    insert into public.bookmarks(user_id,title)
      select '00000000-0000-4000-8000-000000000022','bulk' from generate_series(1,3);
    raise exception 'FAIL: bulk cap bypassed';
  exception when sqlstate 'PT429' then null; end;
  if public.get_bookmark_capacity()->>'used' <> '0' then raise exception 'FAIL: failed bulk leaked usage'; end if;
end $$;
insert into public.bookmarks(user_id,title)
  select '00000000-0000-4000-8000-000000000022','registered' from generate_series(1,2);
-- Idempotent upsert of an existing stable ID must not consume another slot.
insert into public.bookmarks(id,user_id,title)
  select id,user_id,'retry existing' from public.bookmarks
  on conflict (id) do update set title=excluded.title;
reset role;
insert into auth.users(id,is_anonymous) values ('00000000-0000-4000-8000-000000000023',false);
do $$
begin
  begin
    insert into public.bookmarks(user_id,title) values ('00000000-0000-4000-8000-000000000023','project full');
    raise exception 'FAIL: new account bypassed project cap';
  exception when sqlstate 'PT429' then null; end;
end $$;
do $$
begin
  begin
    update public.bookmarks set user_id='00000000-0000-4000-8000-000000000022'
      where user_id='00000000-0000-4000-8000-000000000021';
    raise exception 'FAIL: ownership transfer bypassed destination cap';
  exception when sqlstate 'PT429' then null; end;
  if (select bookmark_count from public.bookmark_capacity_limits where id) <> 3 then
    raise exception 'FAIL: rejected ownership transfer leaked global capacity';
  end if;
end $$;
-- Lowering caps retains rows, allows edits and deletion, but no new growth.
update public.bookmark_capacity_limits set registered_limit=1;
update public.bookmarks set title='existing above limit';
delete from auth.users where id='00000000-0000-4000-8000-000000000022';
do $$
begin
  if (select bookmark_count from public.bookmark_capacity_limits where id) <> 1 then
    raise exception 'FAIL: auth cascade did not free project capacity';
  end if;
end $$;
update public.bookmarks set user_id='00000000-0000-4000-8000-000000000023'
  where user_id='00000000-0000-4000-8000-000000000021';
do $$
begin
  if (select bookmark_count from public.bookmark_capacity_usage where user_id='00000000-0000-4000-8000-000000000021') <> 0
    or (select bookmark_count from public.bookmark_capacity_usage where user_id='00000000-0000-4000-8000-000000000023') <> 1 then
    raise exception 'FAIL: successful ownership transfer did not move usage';
  end if;
end $$;
-- Disabled config still counts; existing data is never rewritten or pruned.
update public.bookmark_capacity_limits set enabled=false;
insert into public.bookmarks(user_id,title)
  select '00000000-0000-4000-8000-000000000023','disabled' from generate_series(1,4);
do $$
begin
  if (select bookmark_count from public.bookmark_capacity_limits where id) <> 5 then
    raise exception 'FAIL: disabled mode lost accounting';
  end if;
end $$;
rollback;

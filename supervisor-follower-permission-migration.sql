begin;

-- The designated supervisor and every follower account can operate order workflows.
create or replace function public.is_follower()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select lower(coalesce(auth.jwt()->>'email', '')) = '505863160@qq.com'
    or exists (
      select 1
      from public.profiles
      where id = auth.uid()
        and role = 'follower'
    );
$$;

revoke all on function public.is_follower() from public;
grant execute on function public.is_follower() to authenticated;

update public.profiles
set role = 'follower'
where lower(email) = '505863160@qq.com'
  and role is distinct from 'follower';

commit;

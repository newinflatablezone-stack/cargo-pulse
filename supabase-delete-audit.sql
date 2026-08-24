-- Record which signed-in account moved an order to the recycle bin.
alter table public.orders
  add column if not exists deleted_by_email text;

create or replace function public.soft_delete_order(target_order_id uuid) returns void
language plpgsql security definer set search_path=public as $$
declare
  actor_email text;
begin
  if not public.is_follower() then
    raise exception 'Only followers can delete orders';
  end if;

  select lower(email) into actor_email
  from public.profiles
  where id=auth.uid();

  update public.orders
  set deleted_at=now(),
      deleted_by_email=coalesce(actor_email, '未知账号'),
      updated_at=now()
  where id=target_order_id
    and deleted_at is null;
end;
$$;

create or replace function public.restore_deleted_order(target_order_id uuid) returns void
language plpgsql security definer set search_path=public as $$
begin
  if not public.can_manage_users() then
    raise exception 'Only the supervisor can restore orders';
  end if;

  update public.orders
  set deleted_at=null,
      deleted_by_email=null,
      updated_at=now()
  where id=target_order_id
    and deleted_at is not null;
end;
$$;

revoke all on function public.soft_delete_order(uuid) from public;
revoke all on function public.restore_deleted_order(uuid) from public;
grant execute on function public.soft_delete_order(uuid) to authenticated;
grant execute on function public.restore_deleted_order(uuid) to authenticated;

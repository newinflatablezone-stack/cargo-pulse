-- Allow follower accounts to soft-delete orders.
-- Deleted orders remain visible only to the supervisor account through the existing RLS policy.

create or replace function public.soft_delete_order(target_order_id uuid)
returns void
language plpgsql
security definer
set search_path=public
as $$
begin
  if not public.is_follower() then
    raise exception 'Only followers can delete orders';
  end if;

  update public.orders
  set deleted_at=now(),
      updated_at=now()
  where id=target_order_id
    and deleted_at is null;
end;
$$;

revoke all on function public.soft_delete_order(uuid) from public;
grant execute on function public.soft_delete_order(uuid) to authenticated;

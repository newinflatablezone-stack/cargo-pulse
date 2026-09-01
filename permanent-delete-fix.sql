begin;

create or replace function public.permanently_delete_order(target_order_id uuid)
returns void
language plpgsql
security definer
set search_path=public
as $$
begin
  if not public.can_manage_users() then
    raise exception 'Only the supervisor can permanently delete orders';
  end if;

  if not exists (
    select 1 from public.orders
    where id=target_order_id and deleted_at is not null
  ) then
    raise exception 'Recycle-bin order not found';
  end if;

  -- Delete known dependent records explicitly. This also repairs installations
  -- whose older foreign keys were created without ON DELETE CASCADE.
  if to_regclass('public.order_shipment_events') is not null
     and to_regclass('public.order_shipments') is not null then
    execute 'delete from public.order_shipment_events where shipment_id in (select id from public.order_shipments where order_id=$1)'
      using target_order_id;
  end if;
  if to_regclass('public.order_shipments') is not null then
    execute 'delete from public.order_shipments where order_id=$1' using target_order_id;
  end if;
  if to_regclass('public.order_factories') is not null then
    execute 'delete from public.order_factories where order_id=$1' using target_order_id;
  end if;
  if to_regclass('public.order_events') is not null then
    execute 'delete from public.order_events where order_id=$1' using target_order_id;
  end if;
  if to_regclass('public.order_images') is not null then
    execute 'delete from public.order_images where order_id=$1' using target_order_id;
  end if;

  delete from public.orders
  where id=target_order_id and deleted_at is not null;

  if not found then
    raise exception 'Permanent deletion failed';
  end if;
end;
$$;

revoke all on function public.permanently_delete_order(uuid) from public;
grant execute on function public.permanently_delete_order(uuid) to authenticated;

commit;

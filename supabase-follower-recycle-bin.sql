-- Cargo Pulse：跟单回收站、恢复与彻底删除权限
-- 在 Supabase SQL Editor 中执行一次。

create or replace function public.list_visible_orders() returns setof public.orders
language sql stable security definer set search_path=public as $$
  select o.* from public.orders o
  where auth.uid() is not null
    and (o.deleted_at is null or public.is_follower())
  order by o.order_date desc,o.created_at desc;
$$;
revoke all on function public.list_visible_orders() from public;
grant execute on function public.list_visible_orders() to authenticated;

drop policy if exists "all users read orders" on public.orders;
create policy "all users read orders" on public.orders for select to authenticated
using(deleted_at is null or public.is_follower());

create or replace function public.restore_deleted_order(target_order_id uuid) returns void
language plpgsql security definer set search_path=public as $$
begin
  if not public.is_follower() then
    raise exception 'Only followers can restore orders';
  end if;
  update public.orders
  set deleted_at=null,deleted_by_email=null,updated_at=now()
  where id=target_order_id and deleted_at is not null;
end; $$;

create or replace function public.permanently_delete_order(target_order_id uuid) returns void
language plpgsql security definer set search_path=public as $$
begin
  if not public.is_follower() then
    raise exception 'Only followers can permanently delete orders';
  end if;
  delete from public.orders
  where id=target_order_id and deleted_at is not null;
end; $$;

revoke all on function public.restore_deleted_order(uuid) from public;
revoke all on function public.permanently_delete_order(uuid) from public;
grant execute on function public.restore_deleted_order(uuid) to authenticated;
grant execute on function public.permanently_delete_order(uuid) to authenticated;

drop policy if exists "supervisor delete order images" on storage.objects;
drop policy if exists "followers delete order images" on storage.objects;
create policy "followers delete order images" on storage.objects
for delete to authenticated
using(bucket_id='order-images' and public.is_follower());

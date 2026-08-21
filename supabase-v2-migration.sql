-- Cargo Pulse V2: roles, complete order workflow, reminders and images
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  role text not null default 'business' check (role in ('follower','business')),
  created_at timestamptz not null default now()
);

create table if not exists public.app_settings (key text primary key,value text not null);
insert into public.app_settings(key,value) values('follower_invite',gen_random_uuid()::text) on conflict(key) do nothing;

create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path=public as $$
begin
  insert into public.profiles(id,email,role)
  values(new.id,new.email,case when lower(new.email)='505863160@qq.com' then 'follower' when new.raw_user_meta_data->>'follower_invite'=(select value from public.app_settings where key='follower_invite') then 'follower' else 'business' end);
  return new;
end; $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute procedure public.handle_new_user();

-- Backfill accounts created before this migration. The oldest account becomes 跟单.
insert into public.profiles(id,email,role)
select u.id,u.email,case when lower(u.email)='505863160@qq.com' then 'follower' else 'business' end
from auth.users u left join public.profiles p on p.id=u.id where p.id is null;

create or replace function public.is_follower() returns boolean language sql stable security definer set search_path=public as $$
  select exists(select 1 from public.profiles where id=auth.uid() and role='follower');
$$;

create or replace function public.can_manage_users() returns boolean language sql stable security definer set search_path=public as $$
  select lower(coalesce(auth.jwt()->>'email',''))='505863160@qq.com';
$$;

create table if not exists public.partners (
  id uuid primary key default gen_random_uuid(),
  kind text not null check(kind in ('factory','forwarder')),
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique(kind,name)
);
insert into public.partners(kind,name) values
('factory','龙一'),('factory','特凡'),('factory','茄果'),('factory','新点'),('factory','蓝宏'),('factory','鼎峰'),('factory','申奥'),
('forwarder','递四方'),('forwarder','众一'),('forwarder','东盛'),('forwarder','讯飞'),('forwarder','嘉城'),('forwarder','善善')
on conflict do nothing;

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  order_no text not null unique,
  product_name text not null,
  size text not null,
  quantity integer not null check(quantity>0),
  customer_info text not null,
  blower text,
  requirements text,
  business_user_id uuid references public.profiles(id),
  inventory_mode text not null check(inventory_mode in ('stock','production')),
  factory_name text,
  needs_rendering boolean not null default false,
  shipping_mode text check(shipping_mode in ('domestic_express','domestic_sea','overseas_warehouse')),
  sea_region text check(sea_region in ('europe','non_europe')),
  overseas_method text check(overseas_method in ('express','truck')),
  forwarder_name text,
  tracking_no text,
  current_step text not null default 'order_created',
  step_started_at timestamptz not null default now(),
  step_deadline timestamptz,
  archived_at timestamptz,
  created_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.orders add column if not exists business_name text;
alter table public.orders add column if not exists order_date date not null default current_date;
alter table public.orders add column if not exists rollback_used boolean not null default false;
alter table public.orders add column if not exists deleted_at timestamptz;

create table if not exists public.order_events (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  step_key text not null,
  started_at timestamptz not null,
  deadline_at timestamptz,
  completed_at timestamptz,
  completed_by uuid references public.profiles(id),
  note text,
  created_at timestamptz not null default now()
);

create table if not exists public.order_images (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  object_path text not null,
  file_name text not null,
  uploaded_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.app_settings enable row level security;
alter table public.partners enable row level security;
alter table public.orders enable row level security;
alter table public.order_events enable row level security;
alter table public.order_images enable row level security;
drop policy if exists "followers read settings" on public.app_settings;
create policy "followers read settings" on public.app_settings for select to authenticated using(public.can_manage_users());
drop policy if exists "profiles read" on public.profiles;
create policy "profiles read" on public.profiles for select to authenticated using(true);
drop policy if exists "followers update roles" on public.profiles;
create policy "followers update roles" on public.profiles for update to authenticated using(public.can_manage_users()) with check(public.can_manage_users());
drop policy if exists "partners read" on public.partners;
create policy "partners read" on public.partners for select to authenticated using(true);
drop policy if exists "followers manage partners" on public.partners;
create policy "followers manage partners" on public.partners for all to authenticated using(public.is_follower()) with check(public.is_follower());
drop policy if exists "all users read orders" on public.orders;
create policy "all users read orders" on public.orders for select to authenticated using(true);
drop policy if exists "followers create orders" on public.orders;
create policy "followers create orders" on public.orders for insert to authenticated with check(public.is_follower());
drop policy if exists "followers update orders" on public.orders;
create policy "followers update orders" on public.orders for update to authenticated using(public.is_follower()) with check(public.is_follower());
drop policy if exists "all users read events" on public.order_events;
create policy "all users read events" on public.order_events for select to authenticated using(true);
drop policy if exists "followers manage events" on public.order_events;
create policy "followers manage events" on public.order_events for all to authenticated using(public.is_follower()) with check(public.is_follower());
drop policy if exists "all users read image records" on public.order_images;
create policy "all users read image records" on public.order_images for select to authenticated using(true);
drop policy if exists "followers manage image records" on public.order_images;
create policy "followers manage image records" on public.order_images for all to authenticated using(public.is_follower()) with check(public.is_follower());

insert into storage.buckets(id,name,public) values('order-images','order-images',false) on conflict(id) do nothing;
drop policy if exists "authenticated view order images" on storage.objects;
create policy "authenticated view order images" on storage.objects for select to authenticated using(bucket_id='order-images');
drop policy if exists "followers upload order images" on storage.objects;
create policy "followers upload order images" on storage.objects for insert to authenticated with check(bucket_id='order-images' and public.is_follower());
drop policy if exists "followers manage order images" on storage.objects;
create policy "followers manage order images" on storage.objects for update to authenticated using(bucket_id='order-images' and public.is_follower());

create index if not exists orders_deadline_idx on public.orders(step_deadline) where archived_at is null;
create index if not exists orders_business_idx on public.orders(business_user_id);
create index if not exists events_order_idx on public.order_events(order_id,created_at);

-- Backfill legacy order steps so early confirmation cannot finish an order accidentally.
update public.orders set
 current_step=case when inventory_mode='stock' then 'ready_to_ship' when needs_rendering then 'rendering' else 'production' end,
 step_started_at=coalesce(step_started_at,created_at),
 step_deadline=case when inventory_mode='stock' then null when needs_rendering then coalesce(step_started_at,created_at)+interval '3 days' else coalesce(step_started_at,created_at)+interval '10 days' end
where current_step='order_created';


-- Ensure the designated supervisor always has follower access.
update public.profiles set role='follower' where lower(email)='505863160@qq.com';

-- Archiving was removed from the product; restore any archived orders.
update public.orders set archived_at=null where archived_at is not null;


-- Supervisor-only recycle bin. Normal followers can update live orders but cannot delete them.
drop policy if exists "all users read orders" on public.orders;
create policy "all users read orders" on public.orders for select to authenticated
using(deleted_at is null or public.can_manage_users());

drop policy if exists "followers create orders" on public.orders;
create policy "followers create orders" on public.orders for insert to authenticated
with check(public.is_follower() and deleted_at is null);

drop policy if exists "followers update orders" on public.orders;
create policy "followers update orders" on public.orders for update to authenticated
using(public.is_follower() and deleted_at is null)
with check(public.is_follower() and deleted_at is null);

create or replace function public.soft_delete_order(target_order_id uuid) returns void
language plpgsql security definer set search_path=public as $$
begin
  if not public.can_manage_users() then raise exception 'Only the supervisor can delete orders'; end if;
  update public.orders set deleted_at=now(),updated_at=now() where id=target_order_id and deleted_at is null;
end; $$;

create or replace function public.restore_deleted_order(target_order_id uuid) returns void
language plpgsql security definer set search_path=public as $$
begin
  if not public.can_manage_users() then raise exception 'Only the supervisor can restore orders'; end if;
  update public.orders set deleted_at=null,updated_at=now() where id=target_order_id and deleted_at is not null;
end; $$;

create or replace function public.permanently_delete_order(target_order_id uuid) returns void
language plpgsql security definer set search_path=public as $$
begin
  if not public.can_manage_users() then raise exception 'Only the supervisor can permanently delete orders'; end if;
  delete from public.orders where id=target_order_id and deleted_at is not null;
end; $$;

revoke all on function public.soft_delete_order(uuid) from public;
revoke all on function public.restore_deleted_order(uuid) from public;
revoke all on function public.permanently_delete_order(uuid) from public;
grant execute on function public.soft_delete_order(uuid) to authenticated;
grant execute on function public.restore_deleted_order(uuid) to authenticated;
grant execute on function public.permanently_delete_order(uuid) to authenticated;

drop policy if exists "supervisor delete order images" on storage.objects;
create policy "supervisor delete order images" on storage.objects for delete to authenticated
using(bucket_id='order-images' and public.can_manage_users());

create index if not exists orders_deleted_idx on public.orders(deleted_at);


-- Imported/backdated orders: the first stage starts from order_date, not import time.
with initial_stage as (
  select id,current_step,order_date::timestamptz as started_at,
    case
      when current_step='rendering' then order_date::timestamptz+interval '3 days'
      when current_step='production' then order_date::timestamptz+interval '10 days'
      else null
    end as deadline_at
  from public.orders
  where deleted_at is null and (
    (current_step='rendering' and needs_rendering=true) or
    (current_step='production' and needs_rendering=false and inventory_mode='production') or
    (current_step='ready_to_ship' and inventory_mode='stock')
  )
)
update public.order_events e
set started_at=i.started_at,deadline_at=i.deadline_at
from initial_stage i
where e.order_id=i.id and e.step_key=i.current_step and e.completed_at is null;

update public.orders
set step_started_at=order_date::timestamptz,
    step_deadline=case
      when current_step='rendering' then order_date::timestamptz+interval '3 days'
      when current_step='production' then order_date::timestamptz+interval '10 days'
      else null
    end,
    updated_at=now()
where deleted_at is null and (
  (current_step='rendering' and needs_rendering=true) or
  (current_step='production' and needs_rendering=false and inventory_mode='production') or
  (current_step='ready_to_ship' and inventory_mode='stock')
);


-- Stable authenticated access: every signed-in user sees every live order.
create or replace function public.list_visible_orders() returns setof public.orders
language sql stable security definer set search_path=public as $$
  select o.* from public.orders o
  where auth.uid() is not null and (o.deleted_at is null or public.can_manage_users())
  order by o.order_date desc,o.created_at desc;
$$;
revoke all on function public.list_visible_orders() from public;
grant execute on function public.list_visible_orders() to authenticated;

-- Role assignment is only available through this supervisor-checked operation.
create or replace function public.set_user_role(target_user_id uuid,target_role text) returns void
language plpgsql security definer set search_path=public as $$
declare target_email text;
begin
  if not public.can_manage_users() then raise exception 'Only the supervisor can assign roles'; end if;
  if target_role not in ('business','follower') then raise exception 'Invalid role'; end if;
  select lower(email) into target_email from public.profiles where id=target_user_id;
  if target_email='505863160@qq.com' and target_role<>'follower' then
    raise exception 'The supervisor account cannot be demoted';
  end if;
  update public.profiles set role=target_role where id=target_user_id;
  if not found then raise exception 'User not found'; end if;
end; $$;
revoke all on function public.set_user_role(uuid,text) from public;
grant execute on function public.set_user_role(uuid,text) to authenticated;

-- Repair visibility and make the designated supervisor immutable.
drop policy if exists "all users read orders" on public.orders;
create policy "all users read orders" on public.orders for select to authenticated
using(deleted_at is null or public.can_manage_users());
update public.profiles set role='follower' where lower(email)='505863160@qq.com';

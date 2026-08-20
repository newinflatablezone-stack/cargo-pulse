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
  values(new.id,new.email,case when not exists(select 1 from public.profiles) then 'follower' when new.raw_user_meta_data->>'follower_invite'=(select value from public.app_settings where key='follower_invite') then 'follower' else 'business' end);
  return new;
end; $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute procedure public.handle_new_user();

-- Backfill accounts created before this migration. The oldest account becomes 跟单.
insert into public.profiles(id,email,role)
select u.id,u.email,case when row_number() over(order by u.created_at)=1 then 'follower' else 'business' end
from auth.users u left join public.profiles p on p.id=u.id where p.id is null;

create or replace function public.is_follower() returns boolean language sql stable security definer set search_path=public as $$
  select exists(select 1 from public.profiles where id=auth.uid() and role='follower');
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
create policy "followers read settings" on public.app_settings for select to authenticated using(public.is_follower());
drop policy if exists "profiles read" on public.profiles;
create policy "profiles read" on public.profiles for select to authenticated using(true);
drop policy if exists "followers update roles" on public.profiles;
create policy "followers update roles" on public.profiles for update to authenticated using(public.is_follower()) with check(public.is_follower());
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

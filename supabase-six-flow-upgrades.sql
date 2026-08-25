-- Cargo Pulse: workflow notes, blower number and independent split shipments
alter table public.orders add column if not exists abnormal_note text;
alter table public.orders add column if not exists blower_tracking_no text;
alter table public.orders add column if not exists split_shipping boolean not null default false;

create table if not exists public.order_shipments (
 id uuid primary key default gen_random_uuid(),
 order_id uuid not null references public.orders(id) on delete cascade,
 batch_name text not null,
 quantity integer not null check(quantity > 0),
 shipping_mode text not null check(shipping_mode in ('domestic_express','air_freight','domestic_sea','overseas_warehouse')),
 forwarder_name text not null,
 sea_region text check(sea_region in ('europe','non_europe')),
 overseas_method text check(overseas_method in ('express','truck')),
 tracking_no text,
 ocean_tracking_no text,
 last_mile_tracking_no text,
 blower_tracking_no text,
 current_step text not null,
 step_started_at timestamptz not null,
 step_deadline timestamptz,
 shipped_at timestamptz not null,
 completed_at timestamptz,
 created_by uuid not null default auth.uid() references public.profiles(id),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(order_id,batch_name)
);
create table if not exists public.order_shipment_events (
 id uuid primary key default gen_random_uuid(),
 shipment_id uuid not null references public.order_shipments(id) on delete cascade,
 step_key text not null,
 started_at timestamptz not null,
 deadline_at timestamptz,
 completed_at timestamptz,
 completed_by uuid references public.profiles(id),
 note text,
 created_at timestamptz not null default now()
);
create index if not exists order_shipments_order_idx on public.order_shipments(order_id);
create index if not exists order_shipments_deadline_idx on public.order_shipments(step_deadline) where completed_at is null;
create index if not exists order_shipment_events_shipment_idx on public.order_shipment_events(shipment_id,created_at);
alter table public.order_shipments enable row level security;
alter table public.order_shipment_events enable row level security;
drop policy if exists "authenticated read order shipments" on public.order_shipments;
create policy "authenticated read order shipments" on public.order_shipments for select to authenticated using(true);
drop policy if exists "followers manage order shipments" on public.order_shipments;
create policy "followers manage order shipments" on public.order_shipments for all to authenticated using(public.is_follower()) with check(public.is_follower());
drop policy if exists "authenticated read shipment events" on public.order_shipment_events;
create policy "authenticated read shipment events" on public.order_shipment_events for select to authenticated using(true);
drop policy if exists "followers manage shipment events" on public.order_shipment_events;
create policy "followers manage shipment events" on public.order_shipment_events for all to authenticated using(public.is_follower()) with check(public.is_follower());
do $$ begin alter publication supabase_realtime add table public.order_shipments; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.order_shipment_events; exception when duplicate_object then null; end $$;

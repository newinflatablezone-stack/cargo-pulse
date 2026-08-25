-- Multiple factories per order with independent production clocks
create table if not exists public.order_factories (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  factory_name text not null,
  started_at timestamptz,
  deadline_at timestamptz,
  completed_at timestamptz,
  completed_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(order_id, factory_name)
);

create index if not exists order_factories_order_idx on public.order_factories(order_id);
create index if not exists order_factories_deadline_idx on public.order_factories(deadline_at) where completed_at is null;

alter table public.order_factories enable row level security;

drop policy if exists "all users read order factories" on public.order_factories;
create policy "all users read order factories"
on public.order_factories for select to authenticated using(true);

drop policy if exists "followers manage order factories" on public.order_factories;
create policy "followers manage order factories"
on public.order_factories for all to authenticated
using(public.is_follower()) with check(public.is_follower());

-- Backfill existing production orders without changing their current workflow.
insert into public.order_factories(order_id,factory_name,started_at,deadline_at,completed_at)
select o.id, trim(o.factory_name), e.started_at, e.deadline_at, e.completed_at
from public.orders o
left join lateral (
  select started_at,deadline_at,completed_at
  from public.order_events
  where order_id=o.id and step_key='production'
  order by started_at
  limit 1
) e on true
where nullif(trim(o.factory_name),'') is not null
on conflict(order_id,factory_name) do nothing;

do $$
begin
  alter publication supabase_realtime add table public.order_factories;
exception
  when duplicate_object then null;
end $$;

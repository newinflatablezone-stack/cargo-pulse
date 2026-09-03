-- 站内“库存 / 物流参数”表格。
-- 登录用户只读；跟单员（含主管）可以覆盖更新。匿名客户查询页无权访问。

create table if not exists public.internal_resource_tables (
  resource_key text primary key check (resource_key in ('inventory', 'logistics')),
  headers jsonb not null default '[]'::jsonb check (jsonb_typeof(headers) = 'array'),
  rows jsonb not null default '[]'::jsonb check (jsonb_typeof(rows) = 'array'),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

insert into public.internal_resource_tables (resource_key)
values ('inventory'), ('logistics')
on conflict (resource_key) do nothing;

alter table public.internal_resource_tables enable row level security;

drop policy if exists "internal resources authenticated read" on public.internal_resource_tables;
create policy "internal resources authenticated read"
on public.internal_resource_tables for select
to authenticated
using (auth.uid() is not null);

drop policy if exists "internal resources follower insert" on public.internal_resource_tables;
create policy "internal resources follower insert"
on public.internal_resource_tables for insert
to authenticated
with check (public.is_follower());

drop policy if exists "internal resources follower update" on public.internal_resource_tables;
create policy "internal resources follower update"
on public.internal_resource_tables for update
to authenticated
using (public.is_follower())
with check (public.is_follower());

revoke all on public.internal_resource_tables from anon;
grant select on public.internal_resource_tables to authenticated;
grant insert, update on public.internal_resource_tables to authenticated;

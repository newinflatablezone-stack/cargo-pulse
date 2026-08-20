create extension if not exists "pgcrypto";

create table if not exists public.shipments (
  id uuid primary key default gen_random_uuid(),
  tracking_no text not null unique,
  route text not null,
  customer text not null,
  status text not null check (status in ('待提货', '运输中', '异常', '已签收')),
  eta date not null,
  carrier text not null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.shipments enable row level security;

-- MVP 只开放匿名只读；写入应在加入登录后按组织成员授权。
create policy "public demo read" on public.shipments
for select to anon using (true);

create index if not exists shipments_status_idx on public.shipments(status);
create index if not exists shipments_eta_idx on public.shipments(eta);

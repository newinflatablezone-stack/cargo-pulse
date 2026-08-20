drop policy if exists "public demo read" on public.shipments;
alter table public.shipments add column if not exists owner_id uuid references auth.users(id) default auth.uid();
alter table public.shipments alter column owner_id set not null;
create policy "users read own shipments" on public.shipments for select to authenticated using (auth.uid() = owner_id);
create policy "users create own shipments" on public.shipments for insert to authenticated with check (auth.uid() = owner_id);
create policy "users update own shipments" on public.shipments for update to authenticated using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy "users delete own shipments" on public.shipments for delete to authenticated using (auth.uid() = owner_id);
create index if not exists shipments_owner_idx on public.shipments(owner_id);

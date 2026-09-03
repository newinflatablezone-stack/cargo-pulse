-- 产品重量：在 Supabase SQL Editor 中执行一次。
-- 单位固定为 kg；内部业务员可读，跟单/主管按现有策略可写，客户公开查询不返回。

begin;

alter table public.orders
  add column if not exists product_weight_kg numeric(12,2);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'orders_product_weight_kg_check'
      and conrelid = 'public.orders'::regclass
  ) then
    alter table public.orders
      add constraint orders_product_weight_kg_check
      check (product_weight_kg is null or product_weight_kg > 0);
  end if;
end $$;

comment on column public.orders.product_weight_kg is
  'Order-level product weight in kilograms. Internal only; never expose through public customer tracking.';

commit;

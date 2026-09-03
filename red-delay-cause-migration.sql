-- 红色超时责任分类：在 Supabase SQL Editor 中执行一次。
-- 内部业务员可以读取，只有现有跟单/主管更新策略允许修改；客户公开查询不会返回该字段。

begin;

alter table public.orders
  add column if not exists red_delay_cause text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'orders_red_delay_cause_check'
      and conrelid = 'public.orders'::regclass
  ) then
    alter table public.orders
      add constraint orders_red_delay_cause_check
      check (red_delay_cause is null or red_delay_cause in ('factory','forwarder','customer'));
  end if;
end $$;

comment on column public.orders.red_delay_cause is
  'Internal red-delay attribution: factory, forwarder, or customer. Never expose through public customer tracking.';

commit;

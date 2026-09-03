-- 物流商付款状态：在 Supabase SQL Editor 中执行一次。
-- 历史订单和新建订单默认均为“已付款”；客户公开查询接口不返回该内部字段。

begin;

alter table public.orders
  add column if not exists forwarder_paid boolean not null default true;

update public.orders
set forwarder_paid = true
where forwarder_paid is null;

comment on column public.orders.forwarder_paid is
  'Whether the logistics provider has been paid. Internal users only; historical default is true.';

commit;

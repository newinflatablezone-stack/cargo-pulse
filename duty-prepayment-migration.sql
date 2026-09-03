-- 订单关税预付状态及备注：在 Supabase SQL Editor 中执行一次。
-- 历史订单与新建订单默认均为“否”；客户公开查询接口不返回这些内部字段。

begin;

alter table public.orders
  add column if not exists duty_prepaid boolean not null default false;

alter table public.orders
  add column if not exists duty_prepaid_note text;

update public.orders
set duty_prepaid = false
where duty_prepaid is null;

comment on column public.orders.duty_prepaid is
  'Whether customs duty is prepaid. Historical default is false.';

comment on column public.orders.duty_prepaid_note is
  'Internal note about customs duty prepayment; never expose through public customer tracking.';

commit;

-- Cargo Pulse reminder alignment (2026-08-21)
-- Run once in the Supabase SQL Editor after the app deployment.

alter table public.orders add column if not exists shipped_at timestamptz;

create or replace function public.transition_order_stage(
  target_order_id uuid,
  target_next_step text,
  target_deadline timestamptz,
  target_shipping jsonb default null,
  target_tracking_no text default null
) returns void
language plpgsql security definer set search_path=public as $$
declare
  current_order public.orders%rowtype;
  transition_time timestamptz:=now();
begin
  if not public.is_follower() then raise exception 'Only followers can advance orders'; end if;
  select * into current_order from public.orders where id=target_order_id and deleted_at is null for update;
  if not found then raise exception 'Order not found'; end if;
  if current_order.current_step='completed' then raise exception 'Completed orders cannot advance'; end if;
  if target_next_step<>'completed' and target_deadline is null then raise exception 'Every active stage requires a deadline'; end if;
  if current_order.current_step in ('production','ready_to_ship','shipping_selection') and target_shipping is null then
    raise exception 'Shipping must be confirmed together with production completion';
  end if;
  if target_shipping is not null and nullif(target_shipping->>'shipped_at','') is null then
    raise exception 'Shipment date is required before shipping timing starts';
  end if;
  if current_order.current_step='tracking' and nullif(trim(target_tracking_no),'') is null then
    raise exception 'Tracking number is required before delivery timing starts';
  end if;

  update public.order_events set completed_at=transition_time,completed_by=auth.uid()
  where order_id=target_order_id and completed_at is null;

  insert into public.order_events(order_id,step_key,started_at,deadline_at)
  values(target_order_id,target_next_step,transition_time,target_deadline);

  update public.orders set
    shipping_mode=case when target_shipping is null then shipping_mode else target_shipping->>'shipping_mode' end,
    forwarder_name=case when target_shipping is null then forwarder_name else target_shipping->>'forwarder_name' end,
    sea_region=case when target_shipping is null then sea_region else nullif(target_shipping->>'sea_region','') end,
    overseas_method=case when target_shipping is null then overseas_method else nullif(target_shipping->>'overseas_method','') end,
    shipped_at=case when target_shipping is null then shipped_at else (target_shipping->>'shipped_at')::timestamptz end,
    tracking_no=coalesce(nullif(trim(target_tracking_no),''),tracking_no),
    current_step=target_next_step,
    step_started_at=case when target_shipping is null then transition_time else (target_shipping->>'shipped_at')::timestamptz end,
    step_deadline=target_deadline,
    rollback_used=false,
    updated_at=transition_time
  where id=target_order_id;
end; $$;

revoke all on function public.transition_order_stage(uuid,text,timestamptz,jsonb,text) from public;
grant execute on function public.transition_order_stage(uuid,text,timestamptz,jsonb,text) to authenticated;

-- Correct production after rendering: 11 natural days from order date.
update public.orders set step_deadline=order_date::timestamptz+interval '11 days',updated_at=now()
where current_step='production' and needs_rendering=true and deleted_at is null;

update public.order_events e set deadline_at=o.step_deadline
from public.orders o where e.order_id=o.id and e.completed_at is null
and o.current_step='production' and o.needs_rendering=true;

-- Preserve the best known shipment date for already-shipped orders.
update public.orders o set shipped_at=coalesce((
  select min(e.started_at) from public.order_events e
  where e.order_id=o.id and e.step_key in ('tracking','domestic_customs')
),o.step_started_at)
where o.shipped_at is null and o.current_step in
('tracking','delivery','domestic_customs','ocean_transit','overseas_customs','warehouse_appointment','last_mile','completed');

-- Repair current shipment-anchored stages.
update public.orders set
  step_started_at=shipped_at,
  step_deadline=shipped_at + case
    when current_step='domestic_customs' and sea_region='europe' then interval '14 days'
    when current_step='domestic_customs' then interval '10 days'
    when current_step='tracking' and shipping_mode='overseas_warehouse' and overseas_method='truck' then interval '5 days'
    when current_step='tracking' then interval '2 days'
    when current_step='delivery' and shipping_mode='overseas_warehouse' then interval '7 days'
    else interval '1 day'
  end,
  updated_at=now()
where deleted_at is null and shipped_at is not null and (
  current_step in ('tracking','domestic_customs') or
  (current_step='delivery' and shipping_mode='overseas_warehouse')
);

update public.order_events e set started_at=o.step_started_at,deadline_at=o.step_deadline
from public.orders o where e.order_id=o.id and e.completed_at is null and (
  o.current_step in ('tracking','domestic_customs') or
  (o.current_step='delivery' and o.shipping_mode='overseas_warehouse')
);

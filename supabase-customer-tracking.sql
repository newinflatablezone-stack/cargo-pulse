-- Cargo Pulse customer tracking portal (run once in Supabase SQL Editor)
-- The browser receives only this function's whitelisted response. RLS remains enabled.
create or replace function public.lookup_customer_tracking(p_order_no text, p_email text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order_no text := lower(regexp_replace(trim(coalesce(p_order_no, '')), '^#+[[:space:]]*', ''));
  v_email text := lower(trim(coalesce(p_email, '')));
  v_order public.orders%rowtype;
  v_result jsonb;
begin
  if length(v_order_no) < 1 or length(v_order_no) > 120
     or length(v_email) < 5 or length(v_email) > 254
     or position('@' in v_email) <= 1 then
    return jsonb_build_object('found', false);
  end if;

  select o.* into v_order
  from public.orders o
  where o.deleted_at is null
    and lower(regexp_replace(trim(o.order_no), '^#+[[:space:]]*', '')) = v_order_no
    and exists (
      select 1
      from regexp_matches(
        lower(o.customer_info),
        '[a-z0-9.!#$%&''*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+',
        'g'
      ) as matched(value)
      where value[1] = v_email
    )
  limit 1;

  if v_order.id is null then
    return jsonb_build_object('found', false);
  end if;

  select jsonb_build_object(
    'found', true,
    'order', jsonb_build_object(
      'order_no', v_order.order_no,
      'customer_info', v_order.customer_info,
      'current_step', v_order.current_step,
      'step_started_at', v_order.step_started_at,
      'step_deadline', v_order.step_deadline,
      'order_date', v_order.order_date,
      'shipping_mode', v_order.shipping_mode,
      'sea_region', v_order.sea_region,
      'overseas_method', v_order.overseas_method,
      'forwarder_name', v_order.forwarder_name,
      'tracking_no', v_order.tracking_no,
      'blower_tracking_no', v_order.blower_tracking_no,
      'split_shipping', v_order.split_shipping
    ),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
        'step_key', e.step_key,
        'started_at', e.started_at,
        'deadline_at', e.deadline_at,
        'completed_at', e.completed_at,
        'tracking_no', case when e.note like 'tracking:%' then substring(e.note from 10) else null end
      ) order by e.started_at, e.created_at, e.id)
      from public.order_events e
      where e.order_id = v_order.id
    ), '[]'::jsonb),
    'shipments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'batch_name', s.batch_name,
        'quantity', s.quantity,
        'shipping_mode', s.shipping_mode,
        'forwarder_name', s.forwarder_name,
        'sea_region', s.sea_region,
        'overseas_method', s.overseas_method,
        'tracking_no', s.tracking_no,
        'ocean_tracking_no', s.ocean_tracking_no,
        'last_mile_tracking_no', s.last_mile_tracking_no,
        'blower_tracking_no', s.blower_tracking_no,
        'current_step', s.current_step,
        'step_started_at', s.step_started_at,
        'step_deadline', s.step_deadline,
        'shipped_at', s.shipped_at,
        'completed_at', s.completed_at,
        'events', coalesce((
          select jsonb_agg(jsonb_build_object(
            'step_key', se.step_key,
            'started_at', se.started_at,
            'deadline_at', se.deadline_at,
            'completed_at', se.completed_at,
            'tracking_no', case when se.note like 'tracking:%' then substring(se.note from 10) else null end
          ) order by se.started_at, se.created_at, se.id)
          from public.order_shipment_events se
          where se.shipment_id = s.id
        ), '[]'::jsonb)
      ) order by s.created_at, s.id)
      from public.order_shipments s
      where s.order_id = v_order.id
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.lookup_customer_tracking(text, text) from public;
grant execute on function public.lookup_customer_tracking(text, text) to anon, authenticated;

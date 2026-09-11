begin;

update public.orders
set forwarder_name = '嘉诚', updated_at = now()
where btrim(forwarder_name) = '嘉城';

do $$
begin
  if to_regclass('public.order_shipments') is not null then
    update public.order_shipments
    set forwarder_name = '嘉诚', updated_at = now()
    where btrim(forwarder_name) = '嘉城';
  end if;
end $$;

delete from public.partners legacy
where legacy.kind = 'forwarder'
  and btrim(legacy.name) = '嘉城'
  and exists (
    select 1 from public.partners canonical
    where canonical.kind = 'forwarder' and btrim(canonical.name) = '嘉诚'
  );

update public.partners
set name = '嘉诚'
where kind = 'forwarder' and btrim(name) = '嘉城';

commit;

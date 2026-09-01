begin;

alter table public.orders
  drop constraint if exists orders_shipping_mode_check;

alter table public.orders
  add constraint orders_shipping_mode_check
  check (
    shipping_mode is null
    or shipping_mode in (
      'domestic_express',
      'air_freight',
      'domestic_sea',
      'domestic_sea_port',
      'overseas_warehouse'
    )
  );

alter table public.order_shipments
  drop constraint if exists order_shipments_shipping_mode_check;

alter table public.order_shipments
  add constraint order_shipments_shipping_mode_check
  check (
    shipping_mode in (
      'domestic_express',
      'air_freight',
      'domestic_sea',
      'domestic_sea_port',
      'overseas_warehouse'
    )
  );

commit;

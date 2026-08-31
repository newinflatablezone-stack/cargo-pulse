-- Allow the 国内空运 mode on existing Cargo Pulse databases.
-- Safe to run repeatedly in Supabase SQL Editor.

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
      'overseas_warehouse'
    )
  );

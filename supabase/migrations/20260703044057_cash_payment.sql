alter table public.payment_methods drop constraint if exists payment_methods_type_check;
alter table public.payment_methods add constraint payment_methods_type_check check (type in ('ewallet','bank','cash'));
alter table public.payment_methods alter column qr_image_url drop not null;

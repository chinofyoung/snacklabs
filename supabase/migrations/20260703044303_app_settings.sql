create table public.app_settings (
  id boolean primary key default true,
  payment_ai_enabled boolean not null default true,
  payment_ai_model text not null default 'claude-opus-4-8'
    check (payment_ai_model in ('claude-haiku-4-5','claude-sonnet-5','claude-opus-4-8')),
  updated_at timestamptz not null default now(),
  constraint app_settings_singleton check (id = true)
);
insert into public.app_settings (id) values (true) on conflict do nothing;
alter table public.app_settings enable row level security;
create policy "app_settings admin read" on public.app_settings for select to authenticated using (public.is_admin());
create policy "app_settings admin write" on public.app_settings for update to authenticated using (public.is_admin()) with check (public.is_admin());

create table public.ai_usage (
  id uuid primary key default gen_random_uuid(),
  fn text not null check (fn in ('verify-payment','analyze-shelf')),
  order_id uuid references public.orders(id),
  session_id uuid references public.restock_sessions(id),
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cache_read_tokens integer not null default 0,
  cache_creation_tokens integer not null default 0,
  cost_usd numeric(12,6) not null default 0,
  cost_php numeric(12,4) not null default 0,
  created_at timestamptz not null default now()
);
alter table public.ai_usage enable row level security;
create policy "ai_usage admin read" on public.ai_usage for select to authenticated using (public.is_admin());
-- inserts happen only via the service-role Edge Functions; no insert policy needed.

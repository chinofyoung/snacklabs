-- Publish notifications to Supabase Realtime.
--
-- The in-app badge subscribes to INSERTs on this table. A table that is not in
-- the supabase_realtime publication produces no change events at all, and the
-- subscription still reports SUBSCRIBED, so without this the badge would only
-- ever update on a page load or a reconnect and nothing would look broken.
--
-- Realtime still applies the "notifications read own" policy to every event
-- before delivering it, so a subscriber only ever receives their own rows.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public' and tablename = 'notifications'
  ) then
    alter publication supabase_realtime add table public.notifications;
  end if;
end;
$$;

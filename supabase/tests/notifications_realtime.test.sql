create extension if not exists pgtap with schema extensions;
begin;
select plan(2);

-- Without membership in the supabase_realtime publication the table emits no
-- change events, and the client's subscription still reports SUBSCRIBED. The
-- live unread badge would then silently never update, so assert it directly.
select is(
  (select count(*)::int from pg_publication_tables
   where pubname = 'supabase_realtime'
     and schemaname = 'public' and tablename = 'notifications'),
  1, 'notifications is published to supabase_realtime');

-- push_subscriptions holds endpoints and keys. Nothing subscribes to it, so it
-- must not be published.
select is(
  (select count(*)::int from pg_publication_tables
   where pubname = 'supabase_realtime'
     and schemaname = 'public' and tablename = 'push_subscriptions'),
  0, 'push_subscriptions is not published to supabase_realtime');

select * from finish();
rollback;

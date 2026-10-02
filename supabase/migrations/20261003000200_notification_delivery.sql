-- Delivery is a disposable side effect of the notification row.
create extension if not exists pg_net;

create or replace function public.tg_dispatch_push()
returns trigger
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_url text;
  v_key text;
begin
  -- THE EXCEPTION HANDLER IS THE POINT OF THIS FUNCTION.
  --
  -- This trigger runs inside the transaction that approved a top-up. A trigger
  -- that raises rolls that transaction back, which would mean a push-delivery
  -- problem could stop someone's money being credited. Nothing about notifying
  -- people is worth that. Any failure here is swallowed; the notification row is
  -- already committed and the in-app badge will still show it.
  begin
    select decrypted_secret into v_url from vault.decrypted_secrets where name = 'send_push_url';
    select decrypted_secret into v_key from vault.decrypted_secrets where name = 'send_push_key';

    if v_url is null or v_key is null then
      -- Not configured in this environment (local test runs, for instance).
      -- In-app notifications still work; only push is skipped.
      return null;
    end if;

    perform net.http_post(
      url := v_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || v_key),
      body := jsonb_build_object('notification_id', new.id)
    );
  exception
    when others then
      raise warning 'push dispatch failed for notification %: %', new.id, sqlerrm;
  end;
  return null;
end;
$$;

create trigger dispatch_push
  after insert on public.notifications
  for each row
  execute function public.tg_dispatch_push();

revoke execute on function public.tg_dispatch_push() from public, anon, authenticated;

-- ===== Which hosts a push endpoint may point at =====
-- send-push POSTs to a stored endpoint from inside Supabase's network, so an
-- endpoint a person can choose freely is a server-side request forgery: they
-- could aim that request at any host, and read the outcome back, because a 404 or
-- 410 deletes the row and they can see their own rows. An endpoint that cannot be
-- STORED can never be fetched, so the rule lives here, in the data, not in the
-- Edge Function.
--
-- Only the browser vendors' own push services are accepted:
--   fcm.googleapis.com                    Chrome and the other Chromium browsers using Google's push (Brave, Opera)
--   *.push.services.mozilla.com           Firefox
--   *.notify.windows.com                  Edge on Windows
--   *.push.apple.com                      Safari / iOS home-screen apps (web.push.apple.com);
--                                         WebKit's own guidance is to allow the whole
--                                         push.apple.com domain, not just that one host
--
-- The HOST is parsed out and matched in full, never searched for inside the
-- string, so none of these get through:
--   https://evil.com/?x=fcm.googleapis.com      (name in the query)
--   https://fcm.googleapis.com.evil.com/        (name as a prefix of another host)
--   https://fcm.googleapis.com@evil.com/        (name as user-info)
-- and a wildcard host must be preceded by a dot, so evilpush.services.mozilla.com
-- is refused while updates.push.services.mozilla.com is accepted.
--
-- Deliberately strict, so that nothing odd is read as a legitimate host:
--   * https only; an optional explicit :443 is the only port allowed.
--   * The host may contain only a-z, 0-9, '.' and '-'. No upper case: real endpoints
--     are lower case, and the raw string is matched rather than lower()-ed first.
--     Case folding depends on the database's locale, and some locales fold non-ASCII
--     characters (a dotted capital I) into ASCII letters, which could let a lookalike
--     host through and then be fetched as a different, attacker-owned host. Not
--     observed to fold on the local stack; avoided because it costs nothing.
--   * After the host, only '/', '?', '#' or the end of the string may follow, which
--     rules out '@', backslashes and percent-encoding being used to hide the real host.
--
-- Immutable so it can sit in a CHECK constraint. NULL is treated as unsupported.
create or replace function public.is_supported_push_endpoint(p_endpoint text)
returns boolean
language sql immutable parallel safe
as $$
  select coalesce(
    substring(p_endpoint from '^https://([a-z0-9.-]+)(?::443)?(?:[/?#]|$)')
      ~ '^(fcm\.googleapis\.com|([a-z0-9-]+\.)*push\.services\.mozilla\.com|([a-z0-9-]+\.)*notify\.windows\.com|([a-z0-9-]+\.)*push\.apple\.com)$',
    false);
$$;

-- A pure function, but not something to publish as an RPC. The CHECK below runs it
-- as whoever writes the row, so authenticated and service_role keep EXECUTE.
revoke execute on function public.is_supported_push_endpoint(text) from public, anon;
grant execute on function public.is_supported_push_endpoint(text) to authenticated, service_role;

-- The backstop. push_subscriptions has an RLS "own rows" policy with INSERT and
-- UPDATE granted, so a client can write the table directly, around
-- claim_push_subscription. The constraint covers every write path (the RPC, a
-- direct insert, an UPDATE of endpoint, the service role) with one rule.
alter table public.push_subscriptions
  add constraint push_subscriptions_endpoint_is_push_service
  check (public.is_supported_push_endpoint(endpoint));

-- ===== claim_push_subscription =====
-- A push endpoint identifies a BROWSER, not a person, and is globally unique.
-- On a shared office phone or tablet, person B can end up subscribing an endpoint
-- that person A already owns. Treated as a plain insert, that collides: B gets an
-- error and no push, while A's row survives, so A's notifications ("Your top-up of
-- 500 was approved") keep arriving on the device B is holding.
--
-- An endpoint belongs to whoever is signed in on that browser NOW, so this takes
-- it over instead of failing: any existing row for the endpoint is removed
-- whoever owned it, and a fresh one is written for the caller. security definer
-- is what lets it delete a row RLS hides from the caller. The delete is scoped to
-- this one endpoint, so none of the previous owner's other devices are touched.
--
-- One account may hold at most 20 subscriptions. send-push fans a notification out
-- to every subscription its recipient has, in a single invocation, so without a cap
-- an approved account could register a long list of valid-looking endpoints and have
-- each of its own notifications multiplied across all of them. Self-inflicted and
-- bounded either way; this just makes the bound explicit. 20 is far above any real
-- number of devices a person turns notifications on for.
--
-- Unlike notify_user/notify_admins, this one IS called from the browser, so it is
-- granted to authenticated rather than revoked from it.
create or replace function public.claim_push_subscription(
  p_endpoint text, p_p256dh text, p_auth text, p_user_agent text default ''
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  c_max_subscriptions constant int := 20;
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  -- Checked before anything is deleted. The table constraint would refuse the
  -- insert anyway, but this gives the caller a clear error rather than a bare
  -- constraint violation. The endpoint is left out of the message on purpose: it
  -- embeds the browser's private push token.
  if not public.is_supported_push_endpoint(p_endpoint) then
    raise exception 'unsupported push endpoint: it must be an https address on a known browser push service'
      using errcode = '22023';
  end if;

  -- Serialise this caller's claims. Without it, concurrent calls each count under
  -- the cap before any of them inserts, and all get through. Scoped to the user,
  -- so one person's claims never wait on another's.
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text, 0));

  delete from public.push_subscriptions where endpoint = p_endpoint;

  -- Counted AFTER the delete, so re-claiming an endpoint the caller already owns
  -- (browsers rotate keys; people toggle off and on) swaps one row for one row and
  -- never trips the cap, even at 20. Refusing here also rolls the delete back, so
  -- a refused claim does not strip an endpoint from its current owner.
  if (select count(*) from public.push_subscriptions where user_id = auth.uid()) >= c_max_subscriptions then
    raise exception 'push subscription limit reached: an account can have at most % devices', c_max_subscriptions
      using errcode = '54000';
  end if;

  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
  values (auth.uid(), p_endpoint, p_p256dh, p_auth, coalesce(p_user_agent, ''))
  returning id into v_id;

  return v_id;
end;
$$;

revoke execute on function public.claim_push_subscription(text, text, text, text) from public, anon;
grant execute on function public.claim_push_subscription(text, text, text, text) to authenticated;

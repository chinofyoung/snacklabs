-- A registered-but-unconfirmed account holds a valid JWT and is
-- `authenticated`, so the policies written as `using (true)` would hand it the
-- entire user list, catalogue and payment methods while it waits. This file
-- narrows those policies to approved accounts and adds the two admin actions
-- the /admin/users page needs.
--
-- Existing users are not affected: 20261002000000_allowed_email_domains.sql
-- backfilled every pre-existing profile as 'approved', so is_active_user()
-- is true for all of them except an account that was already blocked.

-- ===== is_active_user =====
-- True only for an approved, unblocked account. A missing profile, or no
-- session at all (auth.uid() is null), is false rather than null so it can be
-- used directly inside a policy or an `if not` without a coalesce at the call site.
create or replace function public.is_active_user()
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce((
    select approval_status = 'approved' and not is_blocked
    from public.profiles where id = auth.uid()
  ), false)
$$;

-- ===== Narrow the open read policies =====
-- profiles: own row or admin, and nothing wider. Letting every approved user
-- read every profile would expose every registered email address, and each
-- address names a domain on the allowlist, which is meant to stay secret. No
-- customer-facing screen needs another user's profile: AuthContext reads the
-- caller's own row, and every query that embeds `profiles(...)` (AdminOrders,
-- SalesPeople, Topups, Users) lives under /admin and runs as an admin.
-- The own row stays readable regardless of approval or blocking: AuthContext
-- and the pending screen both need it, and without it a pending user could not
-- even be told they are pending.
drop policy if exists "profiles read all" on public.profiles;
create policy "profiles read own or admin" on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_admin());

drop policy if exists "items read" on public.items;
create policy "items read active" on public.items for select to authenticated
  using (public.is_active_user() or public.is_admin());

drop policy if exists "pm read" on public.payment_methods;
create policy "pm read active" on public.payment_methods for select to authenticated
  using (public.is_active_user() or public.is_admin());

-- The wallet tables keep their "own or admin" shape; the own half now also
-- requires an active account, so a pending or blocked user reads nothing of
-- their own either.
drop policy if exists "wallets read own or admin" on public.wallets;
create policy "wallets read own or admin" on public.wallets for select to authenticated
  using ((user_id = auth.uid() and public.is_active_user()) or public.is_admin());

drop policy if exists "wallet_entries read own or admin" on public.wallet_entries;
create policy "wallet_entries read own or admin" on public.wallet_entries for select to authenticated
  using ((user_id = auth.uid() and public.is_active_user()) or public.is_admin());

drop policy if exists "topup_requests read own or admin" on public.topup_requests;
create policy "topup_requests read own or admin" on public.topup_requests for select to authenticated
  using ((user_id = auth.uid() and public.is_active_user()) or public.is_admin());

-- Deliberately NOT narrowed: the `orders read own or admin` and `order_items read`
-- policies (and, in the writes section below, cancel_own_order). This is a
-- decision, not an oversight in the sweep. The sweep exists to stop a pending
-- account from seeing other people's data and from acting on the system. These
-- two policies expose only the caller's own rows (orders is `user_id = auth.uid()
-- or is_admin()`; order_items follows its parent order), so they leak nothing
-- about other users or the domain list. A pending account owns no orders at all:
-- create_order refuses it and there is no other way to insert one. And accounts
-- that were active and have since been blocked or rejected are turned away by the
-- client guards (RequireAuth in src/components/guards.tsx signs a blocked account
-- out; rejection is handled by the approval screens), so a user's own order
-- history is not worth gating on top of that.

-- ===== create_order: refuse unapproved accounts =====
-- Identical to the version in 20260908120000_email_allowlist.sql apart from the
-- added approval check; repeated in full because create or replace needs the
-- whole body. The two refusals stay distinct so the client can tell a revoked
-- account from one still waiting for confirmation.
create or replace function public.create_order(p_items jsonb, p_payment_method_id uuid)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_order_id uuid;
  v_total numeric(10,2) := 0;
  r record;
  v_price numeric(10,2);
  v_stock integer;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if not public.is_active_user() then
    if (select is_blocked from public.profiles where id = auth.uid()) then
      raise exception 'access revoked';
    end if;
    raise exception 'account not approved';
  end if;
  if jsonb_array_length(p_items) = 0 then
    raise exception 'empty order';
  end if;

  insert into public.orders (user_id, total, status, payment_method_id)
  values (auth.uid(), 0, 'awaiting_payment', p_payment_method_id)
  returning id into v_order_id;

  for r in
    select (e->>'item_id')::uuid as item_id, (e->>'qty')::int as qty
    from jsonb_array_elements(p_items) e
  loop
    if r.qty is null or r.qty <= 0 then
      raise exception 'invalid quantity';
    end if;
    select price, stock into v_price, v_stock
    from public.items where id = r.item_id and is_active for update;
    if not found then
      raise exception 'item % not found', r.item_id;
    end if;
    if v_stock < r.qty then
      raise exception 'insufficient stock: %', r.item_id;
    end if;
    insert into public.order_items (order_id, item_id, qty, price_at_purchase)
    values (v_order_id, r.item_id, r.qty, v_price);
    v_total := v_total + v_price * r.qty;
  end loop;

  update public.orders set total = v_total where id = v_order_id;
  return v_order_id;
end;
$$;

-- ===== User-initiated writes: refuse unapproved accounts =====
-- Reads alone are not enough. A pending account holds a valid JWT, and these
-- are the other ways a signed-in non-admin can change data, so each one is
-- closed here in the same shape as create_order. Admin-only paths (approve_topup,
-- reject_topup, confirm_order, void_order, delete_all_orders, apply_restock and
-- the admin-write policies) are deliberately NOT gated on is_active_user().
--
-- Each of the next two functions is its current definition (request_topup from
-- 20261001000100_wallet_topups.sql, pay_order_with_wallet from
-- 20261001000200_wallet_payments.sql) with ONLY the guard replaced; the grants
-- those migrations set survive create or replace.
--
-- Not gated, on purpose: cancel_own_order. It can only move the caller's own
-- awaiting_payment order to cancelled, which holds no stock and no money, so it
-- is cleanup rather than new activity, and the topups migration already records
-- the decision not to refuse revoked accounts there. A pending account owns no
-- orders at all (create_order refuses it), so for them it is inert.

-- ----- request_topup -----
create or replace function public.request_topup(
  p_amount numeric,
  p_payment_method_id uuid,
  p_proof_path text
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  -- Same policy and wording as create_order and pay_order_with_wallet: a
  -- revoked account cannot start new money movement. Deliberately NOT applied
  -- to approve_topup (admin-gated; refusing a blocked user's pending proof
  -- would strand legitimate evidence) nor to cancel_own_order.
  -- Widened from blocked-only to every account that is not active (pending and
  -- rejected as well), in the same two-branch shape as create_order, so the
  -- blocked message the clients match on is unchanged.
  if not public.is_active_user() then
    if (select is_blocked from public.profiles where id = auth.uid()) then
      raise exception 'access revoked';
    end if;
    raise exception 'account not approved';
  end if;

  -- Mirrors the check constraint on topup_requests.amount (and TOPUP_MAX in
  -- src/lib/wallet.ts). Checked here as well so the customer gets a readable
  -- message instead of a raw constraint violation. NaN and Infinity compare
  -- greater than 10000 in Postgres numeric, so the upper bound rejects them.
  if p_amount is null or p_amount <= 0 or p_amount > 10000 then
    raise exception 'amount must be above 0 and at most 10000';
  end if;
  -- Reject rather than round: the column is numeric(10,2), so 100.004 would
  -- be stored as 100.00 and 0.004 would hit the `amount > 0` check as a raw
  -- error. The credited amount must equal what the customer asked for.
  if p_amount <> round(p_amount, 2) then
    raise exception 'amount can have at most two decimal places';
  end if;

  -- The proof must be exactly `<own uid>/<file>`: a literal first segment, one
  -- level deep, and a real file name. Without the folder rule a customer could
  -- attach someone else's proof image to their own request. The stricter shape
  -- matters because the storage policies key on the literal first path
  -- segment, so `<uid>/../<other uid>/x`, `<uid>/a/`, a blank or `.`/`..` file
  -- name, and control characters must not slip through as "inside my folder".
  -- The uuid text is hex and dashes only, so interpolating it into the pattern
  -- cannot inject regex.
  if p_proof_path is null
     or p_proof_path !~ ('^' || auth.uid()::text || '/(?!\.{1,2}$)[^/[:space:]][^/[:cntrl:]]*$') then
    raise exception 'proof path must be in your own folder';
  end if;

  -- Enforced here, not only by the client (Wallet.tsx filters is_active and
  -- type <> 'wallet'): the method is what the admin reconciles the proof
  -- against, so an inactive one is meaningless, and a top-up "paid from the
  -- wallet" would be circular. An unknown id is covered too, so it surfaces as
  -- this message rather than a raw foreign-key violation. A null method is
  -- still allowed, as before.
  if p_payment_method_id is not null and not exists (
    select 1 from public.payment_methods
    where id = p_payment_method_id and is_active and type <> 'wallet'
  ) then
    raise exception 'that payment method is not available for top-ups';
  end if;

  begin
    insert into public.topup_requests (user_id, amount, payment_method_id, proof_path)
    values (auth.uid(), p_amount, p_payment_method_id, p_proof_path)
    returning id into v_id;
  exception when unique_violation then
    -- topup_requests_one_pending_per_user: the only unique index that a
    -- freshly generated id can collide on.
    raise exception 'you already have a top-up waiting for approval';
  end;

  return v_id;
end;
$$;

-- ----- pay_order_with_wallet -----
create or replace function public.pay_order_with_wallet(p_order_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_user_id uuid;
  v_status text;
  v_type text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  -- Same policy and wording as create_order: a revoked account cannot spend.
  -- Blocking does not cancel outstanding orders, so a blocked customer can
  -- still be holding an awaiting_payment wallet order; without this they could
  -- spend their balance and take the stock after their access was withdrawn.
  -- Widened from blocked-only to every account that is not active (pending and
  -- rejected as well), in the same two-branch shape as create_order, so the
  -- blocked message the clients match on is unchanged.
  if not public.is_active_user() then
    if (select is_blocked from public.profiles where id = auth.uid()) then
      raise exception 'access revoked';
    end if;
    raise exception 'account not approved';
  end if;

  select o.user_id, o.status, pm.type into v_user_id, v_status, v_type
  from public.orders o
  left join public.payment_methods pm on pm.id = o.payment_method_id
  where o.id = p_order_id for update of o;
  if not found then
    raise exception 'order not found';
  end if;

  if v_user_id <> auth.uid() then
    raise exception 'forbidden';
  end if;
  if v_status <> 'awaiting_payment' then
    raise exception 'order not payable (status %)', v_status;
  end if;
  -- Requiring the wallet method stops a QR-method order from being silently
  -- paid out of the balance.
  if v_type is distinct from 'wallet' then
    raise exception 'this order is not set to pay from your wallet';
  end if;

  update public.orders set status = 'paid' where id = p_order_id;
end;
$$;

-- ===== Storage: uploads need an active account =====
-- The upload/overwrite policies for the two customer-written buckets also have
-- to require an active account, or a pending user could still put files into
-- storage and, for topup-proofs, attach one to a request. Reads of one's own
-- object stay as they were (a user can only read what they uploaded, and a
-- pending user has uploaded nothing). The admin-write and restock policies are
-- admin-only and untouched.
drop policy if exists "receipts upload own" on storage.objects;
create policy "receipts upload own" on storage.objects for insert to authenticated
  with check (bucket_id = 'receipts' and owner = auth.uid() and public.is_active_user());

drop policy if exists "receipts reupload own" on storage.objects;
create policy "receipts reupload own" on storage.objects for update to authenticated
  using (bucket_id = 'receipts' and owner = auth.uid() and public.is_active_user())
  with check (bucket_id = 'receipts' and owner = auth.uid() and public.is_active_user());

drop policy if exists "topup proofs upload own" on storage.objects;
create policy "topup proofs upload own" on storage.objects for insert to authenticated
  with check (bucket_id = 'topup-proofs'
              and (storage.foldername(name))[1] = auth.uid()::text
              and public.is_active_user());

-- No explicit WITH CHECK, as in the original: Postgres applies this USING
-- expression to the new row as well.
drop policy if exists "topup proofs reupload own" on storage.objects;
create policy "topup proofs reupload own" on storage.objects for update to authenticated
  using (bucket_id = 'topup-proofs'
         and (storage.foldername(name))[1] = auth.uid()::text
         and public.is_active_user());

-- Listing the public catalogue and QR-code buckets is a read of payment-method
-- data (the QR images) that the table policy above is meant to hide from a
-- pending account. Fetching an object by its public URL does not go through
-- this policy, so customers' <img> tags are unaffected; only listing is.
drop policy if exists "public buckets read" on storage.objects;
create policy "public buckets read" on storage.objects for select to authenticated
  using (bucket_id in ('item-images', 'qr-codes')
         and (public.is_active_user() or public.is_admin()));

-- ===== set_registration_status (admin only) =====
create or replace function public.set_registration_status(p_user_id uuid, p_status text)
returns text
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'forbidden';
  end if;
  -- `null not in (...)` is null, not true, so a null status would slip past a
  -- bare `not in` and only be stopped later by the column's NOT NULL.
  if p_status is null or p_status not in ('approved', 'rejected') then
    raise exception 'invalid status';
  end if;
  -- Same stance as set_user_access and protect_last_admin: one admin's click
  -- must not strand another behind the rejected screen. Only rejection can do
  -- that, so confirming an admin stays allowed; it is how a user who was
  -- promoted before being approved gets out of 'pending'.
  if p_status = 'rejected' and exists (
    select 1 from public.profiles where id = p_user_id and is_admin
  ) then
    raise exception 'cannot reject an admin';
  end if;

  update public.profiles
     set approval_status = p_status,
         approved_by = auth.uid(),
         approved_at = now()
   where id = p_user_id;

  if not found then
    raise exception 'user not found';
  end if;

  return p_status;
end;
$$;

-- ===== set_user_access (admin only) =====
-- Replaces the blocking half of the dropped set_email_access. Takes a user id
-- rather than an email: with the per-address allowlist gone, revocation is a
-- property of an account, not of a string.
create or replace function public.set_user_access(p_user_id uuid, p_allowed boolean)
returns text
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'forbidden';
  end if;

  if not p_allowed and exists (
    select 1 from public.profiles where id = p_user_id and is_admin
  ) then
    raise exception 'cannot revoke access for an admin';
  end if;

  update public.profiles set is_blocked = not p_allowed where id = p_user_id;

  if not found then
    raise exception 'user not found';
  end if;

  return case when p_allowed then 'restored' else 'revoked' end;
end;
$$;

-- ===== Who may call these =====
-- Same shape as the three newest migrations (20261001000100_wallet_topups.sql,
-- 20261001000200_wallet_payments.sql, 20261001000300_wallet_total.sql): revoke
-- EXECUTE from PUBLIC and from anon (which holds its own explicit default-ACL
-- grant, so revoking PUBLIC alone is not enough), then grant it back to
-- `authenticated` only. The two admin RPCs still check is_admin() inside, and
-- is_active_user() still returns false for anon; this just makes "signed-in
-- users only" true at the privilege level instead of relying on the body.
--
-- `authenticated` MUST keep EXECUTE on is_active_user(), and is granted it
-- explicitly below. Row-level-security policy expressions are evaluated with the
-- privileges of the role running the query (the caller, not the table owner, and
-- not the function's definer), and a function referenced in a policy is
-- permission-checked against that role. Without EXECUTE every policy above that
-- calls is_active_user() would fail with "permission denied for function" for
-- every signed-in user. The same is already true of is_admin(), which is why
-- that one has never been revoked from authenticated. anon is safe to revoke:
-- every policy touched here is `to authenticated`, so none of them is ever
-- evaluated for anon. create_order and the other security-definer callers run
-- as the function owner, which keeps EXECUTE regardless.
revoke execute on function public.is_active_user() from public, anon;
revoke execute on function public.set_registration_status(uuid, text) from public, anon;
revoke execute on function public.set_user_access(uuid, boolean) from public, anon;

grant execute on function public.is_active_user() to authenticated;
grant execute on function public.set_registration_status(uuid, text) to authenticated;
grant execute on function public.set_user_access(uuid, boolean) to authenticated;

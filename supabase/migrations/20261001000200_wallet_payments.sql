-- Spending the wallet balance at checkout.
--
-- The money movement lives in TRIGGERS on public.orders, not in the RPC, for
-- the same reason 20260908130000_stock_holds_on_review.sql moved stock
-- accounting into triggers: two of the three places that change an order's
-- status are plain table updates, not RPCs, and cannot be taught to remember
-- to move money --
--   - supabase/functions/verify-payment/index.ts sets 'needs_review'
--   - src/pages/admin/AdminOrders.tsx's reject() sets 'cancelled'
-- Putting it in triggers makes void_order, delete_all_orders and that reject
-- path all refund correctly without any of them knowing wallets exist.

-- ===== 'wallet' payment method type (mirrors the 'cash' migration) =====
alter table public.payment_methods drop constraint if exists payment_methods_type_check;
alter table public.payment_methods add constraint payment_methods_type_check
  check (type in ('ewallet','bank','cash','wallet'));

-- Seeded INACTIVE, deliberately. This project's dev environment points at
-- production, so a migration can land before the frontend that understands
-- type = 'wallet' does. Customers still on the old bundle would then be offered
-- a "Wallet" row at checkout: the old Cart.tsx auto-selects the first method
-- and the old Pay.tsx has no wallet branch, so they would reach a broken QR
-- image and a receipt picker for an order that can only be paid from the
-- balance. Shipping it off means a migration that lands ahead of the bundle
-- cannot expose a half-working payment method. An admin switches it on from
-- the Payments screen (Enable) once the new frontend is live.
insert into public.payment_methods (label, type, account_name, account_number, qr_image_url, is_active)
select 'Wallet', 'wallet', '', '', null, false
where not exists (select 1 from public.payment_methods where type = 'wallet');

-- Deleting it would strand pay_order_with_wallet and orphan every checkout
-- using it. Re-typing it is worse than deleting it: sync_order_wallet decides
-- whether to debit by looking for type = 'wallet', so once the type changed,
-- confirming an existing wallet order would send it to 'paid' with stock
-- deducted and NO debit taken. Both are refused. Deactivating (is_active =
-- false) and relabelling stay allowed, and deactivating is the supported way
-- to turn the wallet off (and activating, the way it is turned on: it is seeded
-- inactive above). In the spirit of protect_last_admin.
--
-- The guard only protects the row that IS a wallet method; it does not stop
-- another method being re-typed INTO 'wallet'. That is harmless to money
-- (refunds follow the ledger, never the method's type) and is exercised in
-- wallet_payments.test.sql.
create or replace function public.protect_wallet_method()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    if old.type = 'wallet' then
      raise exception 'the wallet payment method cannot be deleted; deactivate it instead';
    end if;
    return old;
  end if;

  if old.type = 'wallet' and new.type is distinct from 'wallet' then
    raise exception 'the wallet payment method''s type cannot be changed; deactivate it instead';
  end if;
  return new;
end;
$$;

drop trigger if exists protect_wallet_method on public.payment_methods;
create trigger protect_wallet_method
  before delete or update on public.payment_methods
  for each row execute function public.protect_wallet_method();

-- ===== orders.total can never be negative =====
-- Nothing in the schema stopped it (create_order cannot produce one, but an
-- admin UPDATE can). It matters here because the debit's guard is
-- `balance >= total`, which is always true for a negative total, so
-- `balance - total` would CREDIT the wallet and write a positive "purchase":
-- money minted from a status change. The debit branch below also refuses to
-- act on a non-positive total; this constraint is the first line, that
-- condition the second.
alter table public.orders drop constraint if exists orders_total_nonneg;
alter table public.orders add constraint orders_total_nonneg check (total >= 0);

-- ===== sync_order_wallet (AFTER UPDATE on orders) =====
-- Trigger naming note: Postgres fires same-timing triggers in NAME order, so
-- on public.orders the sequence is sync_order_stock then sync_order_wallet --
-- locks are taken order -> items -> wallet. Which of items/wallet comes first
-- does not affect correctness (both run in the transaction that changed the
-- status, so a failure in either rolls back the other). What matters is that
-- the order is the SAME on every path, which rules out deadlock between two
-- concurrent checkouts.
create or replace function public.sync_order_wallet()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_is_wallet boolean;
  v_outstanding numeric(10,2);
begin
  if old.status is distinct from new.status then

    if old.status <> 'paid' and new.status = 'paid' then
      select pm.type = 'wallet' into v_is_wallet
      from public.payment_methods pm where pm.id = new.payment_method_id;

      -- A zero total has nothing to debit (and writing a 0.00 "purchase" would
      -- only clutter the history; the refund side already nets zero). A
      -- negative total must never reach the update below, where it would
      -- credit instead of debit -- see orders_total_nonneg above.
      if coalesce(v_is_wallet, false) and new.total > 0 then
        perform public.ensure_wallet(new.user_id);
        -- Guarded update + not-found check, the same shape sync_order_stock
        -- uses: it yields a specific, friendly error instead of a raw
        -- check-constraint violation. Raising aborts the transaction, which
        -- rolls back the status change too -- intentional: an order must
        -- never sit in 'paid' without the money having actually moved.
        --
        -- Concurrency: this being ONE guarded UPDATE is what makes two
        -- simultaneous checkouts safe. The second waits on the first's row
        -- lock, and Postgres then re-checks `balance >= new.total` against
        -- the updated row version (READ COMMITTED EvalPlanQual). Never
        -- "simplify" it into a read-then-write (select the balance, compare,
        -- then update): that lets both pass the check. pgTAP cannot test this
        -- (one session, one transaction), so this comment is the only record.
        update public.wallets
        set balance = balance - new.total, updated_at = now()
        where user_id = new.user_id and balance >= new.total;
        if not found then
          raise exception 'insufficient wallet balance';
        end if;

        insert into public.wallet_entries (user_id, amount, kind, order_id, note)
        values (new.user_id, -new.total, 'purchase', new.id,
                'Order #' || left(new.id::text, 8));
      end if;

    elsif old.status = 'paid' and new.status <> 'paid' then
      -- Refund what was ACTUALLY taken, computed from the ledger rather than
      -- from orders.total. That keeps this correct in the awkward cases: an
      -- order never paid by wallet nets zero and is skipped, an already
      -- refunded order nets zero and is not refunded twice, and the trigger
      -- stays right even if an admin later edits or deactivates the wallet
      -- payment method.
      --
      -- Scoped to new.user_id because the credit below goes to that user: the
      -- `orders admin update` policy lets an admin reassign orders.user_id,
      -- and without the scope a reassigned-then-cancelled order would credit
      -- the new owner with money that was debited from the old one.
      --
      -- The cost is deliberate: a reassigned-then-cancelled order refunds
      -- nobody, and the original payer stays debited. A missing credit is
      -- visible in the ledger (the purchase entry survives with its order_id)
      -- and fixable by an admin adjustment; a credit to the WRONG wallet is
      -- spendable and is not. If reassigning a paid order ever becomes a
      -- supported action, it needs its own refund-to-original-payer step --
      -- do not recover it by dropping this user_id scope.
      select coalesce(-sum(amount), 0)::numeric(10,2) into v_outstanding
      from public.wallet_entries
      where order_id = new.id and user_id = new.user_id;

      if v_outstanding > 0 then
        perform public.ensure_wallet(new.user_id);
        update public.wallets
        set balance = balance + v_outstanding, updated_at = now()
        where user_id = new.user_id;

        insert into public.wallet_entries (user_id, amount, kind, order_id, note)
        values (new.user_id, v_outstanding, 'refund', new.id,
                'Refund · order #' || left(new.id::text, 8));
      end if;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists sync_order_wallet on public.orders;
create trigger sync_order_wallet
  after update on public.orders
  for each row execute function public.sync_order_wallet();

-- ===== release_order_wallet (BEFORE DELETE on orders) =====
-- void_order and delete_all_orders DELETE the row rather than restatusing it,
-- so the refund needs a delete-time twin. It runs BEFORE the delete, so the
-- entry is written while the order still exists; the FK then nulls order_id
-- and `note` carries the readable reference forward.
create or replace function public.release_order_wallet()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_outstanding numeric(10,2);
begin
  if old.status = 'paid' then
    -- Scoped to old.user_id for the same reason as in sync_order_wallet, and
    -- with the same deliberate cost: read the comment there before changing
    -- this scope.
    select coalesce(-sum(amount), 0)::numeric(10,2) into v_outstanding
    from public.wallet_entries
    where order_id = old.id and user_id = old.user_id;

    if v_outstanding > 0 then
      perform public.ensure_wallet(old.user_id);
      update public.wallets
      set balance = balance + v_outstanding, updated_at = now()
      where user_id = old.user_id;

      insert into public.wallet_entries (user_id, amount, kind, order_id, note)
      values (old.user_id, v_outstanding, 'refund', old.id,
              'Refund · order #' || left(old.id::text, 8));
    end if;
  end if;
  return old;
end;
$$;

drop trigger if exists release_order_wallet on public.orders;
create trigger release_order_wallet
  before delete on public.orders
  for each row execute function public.release_order_wallet();

-- ===== pay_order_with_wallet (customer) =====
-- Deliberately thin: it validates, then flips the status and lets the trigger
-- do all the money. It does NOT call confirm_order, whose
-- `is_admin() or service_role` check would reject a customer caller.
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
  if (select is_blocked from public.profiles where id = auth.uid()) then
    raise exception 'access revoked';
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

-- ===== Who may call these =====
-- pay_order_with_wallet is for signed-in users only. The explicit revoke is
-- what makes that true: on the local stack (verified in pg_default_acl and
-- proacl, as in 20261001000100_wallet_topups.sql), a new function in `public`
-- gets EXECUTE for PUBLIC *and* for anon, authenticated and service_role, so
-- a bare `grant execute ... to authenticated` adds nothing and leaves
-- signed-out visitors able to call it. The function would still refuse them
-- (auth.uid() is null), but that is a second line of defence, not the first.
-- Revoking from PUBLIC alone is not enough either: anon holds its own
-- explicit grant, so it is named too. service_role and the owner are left
-- untouched. Only `authenticated` is granted back; ownership, status and
-- payment-method checks are then enforced inside the function.
revoke execute on function public.pay_order_with_wallet(uuid) from public, anon;
grant execute on function public.pay_order_with_wallet(uuid) to authenticated;

-- The three trigger functions are never called by a client: Postgres invokes
-- them as the trigger fires, and EXECUTE is checked only when a trigger is
-- created, not when it fires. So nobody needs the default grants on them, and
-- they are removed for the same reason as above (PUBLIC, plus the explicit
-- anon/authenticated grants). This does not stop the triggers firing for a
-- plain table update made by an `authenticated` admin (AdminOrders.tsx's
-- reject); wallet_payments.test.sql proves that path refunds.
revoke execute on function public.protect_wallet_method() from public, anon, authenticated;
revoke execute on function public.sync_order_wallet() from public, anon, authenticated;
revoke execute on function public.release_order_wallet() from public, anon, authenticated;

-- Customer-initiated top-up requests and the admin's manual approve/reject.
-- Approval is the only path that credits a wallet: customers cannot write to
-- wallets, wallet_entries or topup_requests directly (see
-- 20261001000000_wallet_schema.sql), so these three functions are the whole
-- top-up lifecycle.

-- ===== Storage: private proof images, mirroring the receipts bucket =====
-- The limits are not about storage cost. The CUSTOMER chooses the content-type
-- a proof is stored with, and an admin later opens that object at full size, so
-- an allowlist removes "customer-chosen content, opened by an admin" as an
-- angle. They match the client (Wallet.tsx): it compresses to JPEG and refuses
-- anything over PROOF_MAX_BYTES (5 MiB). Enforced by the Storage API at upload
-- time, not by SQL, so a direct insert into storage.objects is not covered.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('topup-proofs', 'topup-proofs', false, 5242880, array['image/jpeg'])
on conflict (id) do nothing;

-- Keyed on the first path segment (the customer's user id) rather than on
-- storage's `owner` column as the receipts policies are: the same folder rule
-- is enforced again inside request_topup, so a proof can only ever be attached
-- to a request by the customer whose folder it lives in.
create policy "topup proofs upload own" on storage.objects for insert to authenticated
  with check (bucket_id = 'topup-proofs' and (storage.foldername(name))[1] = auth.uid()::text);
-- No explicit `with check`: Postgres then applies this `using` expression to
-- the NEW row as well, so a customer cannot rename an object into someone
-- else's folder.
--
-- NOT independently covered by wallet_topups.test.sql. The "move own proof into
-- another folder" test exercises the end behaviour, but it cannot ISOLATE this
-- implicit WITH CHECK: the SELECT policy is also applied to the new row, so the
-- move still fails even with this `using` relaxed to true. A test that isolates
-- it would have to run as an admin (who can see both rows): upload
-- <admin uid>/x.jpg, then move it into another user's folder, so only the
-- implicit WITH CHECK can block it. Left undone deliberately; do not read the
-- passing suite as proof of this clause.
create policy "topup proofs reupload own" on storage.objects for update to authenticated
  using (bucket_id = 'topup-proofs' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "topup proofs read own or admin" on storage.objects for select to authenticated
  using (bucket_id = 'topup-proofs'
         and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin()));
-- No delete policy on purpose: a proof is evidence for an admin's decision and
-- must outlive the request, approved or not.

-- ===== request_topup (customer) =====
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
  if (select is_blocked from public.profiles where id = auth.uid()) then
    raise exception 'access revoked';
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

-- ===== approve_topup (admin) =====
-- The only place a wallet is credited. Three guards stack so a request can
-- never pay out twice: the row lock plus the `status = 'pending'` check
-- serialise two admins clicking at once (the loser re-reads the committed
-- 'approved' status after the lock releases), and wallet_entries_topup_unique
-- is a database-level backstop if both of those were ever bypassed.
create or replace function public.approve_topup(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_user_id uuid;
  v_amount numeric(10,2);
  v_status text;
begin
  if not public.is_admin() then
    raise exception 'forbidden';
  end if;

  select user_id, amount, status into v_user_id, v_amount, v_status
  from public.topup_requests where id = p_id for update;
  if not found then
    raise exception 'top-up request not found';
  end if;
  if v_status <> 'pending' then
    raise exception 'top-up already %', v_status;
  end if;

  -- An admin cannot approve their own top-up. Approval is the ONLY path that
  -- credits a wallet, so without this a single admin could mint themselves
  -- balance with no second pair of eyes. Rejecting your own request stays
  -- allowed: no money moves, and it lets an admin clear their own mistaken
  -- request so they can submit a corrected one. Placed after the is_admin()
  -- and status checks so a non-admin still gets 'forbidden' and an
  -- already-resolved request still reports its real status; the refusal must
  -- not mask a more specific error.
  if v_user_id = auth.uid() then
    raise exception 'you cannot approve your own top-up';
  end if;

  -- A credit can never be applied to a missing row.
  perform public.ensure_wallet(v_user_id);

  -- Lock the wallet row before touching it, so a concurrent purchase
  -- serialises behind this credit rather than racing it.
  perform 1 from public.wallets where user_id = v_user_id for update;

  -- Ledger and cached balance move together, in this one transaction. The
  -- balance is updated here rather than by a trigger on wallet_entries: the
  -- purchase/refund triggers live on public.orders (wallet_payments migration)
  -- and move the balance themselves, so there is no second writer to
  -- double-count against.
  insert into public.wallet_entries (user_id, amount, kind, topup_id, note)
  values (v_user_id, v_amount, 'topup', p_id, 'Top-up approved');

  update public.wallets
  set balance = balance + v_amount, updated_at = now()
  where user_id = v_user_id;

  update public.topup_requests
  set status = 'approved', reviewed_by = auth.uid(), reviewed_at = now()
  where id = p_id;
end;
$$;

-- ===== reject_topup (admin) =====
-- Writes no ledger entry: nothing moved. The reason is shown to the customer
-- on their Top up tab, which is why the client has to merge rejected requests
-- into the history list rather than reading wallet_entries alone.
create or replace function public.reject_topup(p_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_status text;
begin
  if not public.is_admin() then
    raise exception 'forbidden';
  end if;

  select status into v_status from public.topup_requests where id = p_id for update;
  if not found then
    raise exception 'top-up request not found';
  end if;
  if v_status <> 'pending' then
    raise exception 'top-up already %', v_status;
  end if;

  update public.topup_requests
  set status = 'rejected',
      reject_reason = coalesce(nullif(trim(p_reason), ''), 'No reason given'),
      reviewed_by = auth.uid(),
      reviewed_at = now()
  where id = p_id;
end;
$$;

-- ===== Who may call these =====
-- Only signed-in users. The explicit revoke is what makes that true: on the
-- local stack (verified in pg_default_acl and proacl), a new function in
-- `public` gets EXECUTE for PUBLIC *and* for anon, authenticated and
-- service_role, so a bare `grant execute ... to authenticated` adds nothing
-- and leaves signed-out visitors able to call all three. The functions would
-- still refuse them (auth.uid() is null, is_admin() is false), but that is a
-- second line of defence, not the first. Revoking from PUBLIC alone is not
-- enough either: anon holds its own explicit grant, so it is named too.
-- service_role (RLS-bypassing, used by edge functions) and the owner are left
-- untouched. Only `authenticated` is granted back, and admin-ness is then
-- enforced inside approve_topup/reject_topup via is_admin().
revoke execute on function public.request_topup(numeric, uuid, text) from public, anon;
revoke execute on function public.approve_topup(uuid) from public, anon;
revoke execute on function public.reject_topup(uuid, text) from public, anon;

grant execute on function public.request_topup(numeric, uuid, text) to authenticated;
grant execute on function public.approve_topup(uuid) to authenticated;
grant execute on function public.reject_topup(uuid, text) to authenticated;

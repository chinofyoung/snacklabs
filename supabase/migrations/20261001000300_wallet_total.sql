-- The admin's "how much does the pantry owe its users" figure: the total
-- prepaid balance held across every customer wallet.
--
-- This is a function rather than a client-side sum because PostgREST has no
-- SUM aggregate, and a browser-side sum fails in the one direction that
-- matters for a liability: it reads LOW. An RLS-filtered read returns 200 with
-- `error: null` and simply fewer rows, and PostgREST caps a result at 1000
-- rows, so either one would silently understate what is owed. One function,
-- one number, summed where every row is visible, with nothing to truncate.
--
-- Admin-only. Security definer so the sum is over every wallet whatever the
-- caller's RLS would show, which is exactly why the is_admin() check has to be
-- inside it: a customer would otherwise learn the pantry's total liability.
-- Same 'forbidden' wording as approve_topup and reject_topup.
--
-- `coalesce` is there because sum() over no rows is null, not 0. With no
-- wallets the answer is a real zero and must read as one. The dashboard treats
-- a null result as a failed read ("—" plus a note), so without this a pantry
-- with no wallets would look broken instead of showing ₱0.00.
create or replace function public.total_wallet_balance()
returns numeric
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'forbidden';
  end if;
  return coalesce((select sum(balance) from public.wallets), 0);
end;
$$;

-- Only signed-in users may call it; admin-ness is then enforced inside via
-- is_admin(). The explicit revoke is what makes the first half true: this
-- project's pg_default_acl grants EXECUTE on a new function to PUBLIC *and*,
-- separately, to anon, so a bare `grant ... to authenticated` adds nothing,
-- and revoking from PUBLIC alone leaves anon's own grant in place. Both are
-- named, as in 20261001000100_wallet_topups.sql. service_role and the owner
-- are left untouched.
revoke execute on function public.total_wallet_balance() from public, anon;
grant execute on function public.total_wallet_balance() to authenticated;

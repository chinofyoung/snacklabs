-- Notifications are raised by triggers on the table whose state changed, never
-- by the function or page that changed it.
--
-- Two reasons. First, `needs_review` is not set by an RPC at all —
-- supabase/functions/verify-payment/index.ts writes it directly with the service
-- role — so an RPC-based hook would miss the event admins most need. Second,
-- hooking the others would mean `create or replace` on approve_topup and friends,
-- whose bodies carry wallet row locking and a self-approval guard; retyping them
-- to add one line is how logic gets silently dropped.
--
-- Every trigger is guarded so a repeated or unrelated write cannot notify twice.

-- ===== topup_requests: resolved =====
create or replace function public.tg_notify_topup_resolved()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.status = 'approved' then
    perform public.notify_user(
      new.user_id, 'topup_approved', 'Top-up approved',
      'Your top-up of ' || to_char(new.amount, 'FM999,999,990.00') || ' has been added to your wallet.',
      '/wallet');
  elsif new.status = 'rejected' then
    perform public.notify_user(
      new.user_id, 'topup_rejected', 'Top-up not approved',
      case when coalesce(new.reject_reason, '') = ''
        then 'Your top-up was not approved.'
        else 'Your top-up was not approved: ' || new.reject_reason
      end,
      '/wallet');
  end if;
  return null;
end;
$$;

-- `when` clause rather than an `if` in the body: the guard belongs in the
-- trigger definition so a rewrite of the same status, or an update to an
-- unrelated column, never reaches the function at all.
create trigger notify_topup_resolved
  after update of status on public.topup_requests
  for each row
  when (old.status = 'pending' and new.status in ('approved', 'rejected'))
  execute function public.tg_notify_topup_resolved();

-- ===== topup_requests: requested =====
create or replace function public.tg_notify_topup_requested()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  perform public.notify_admins(
    'topup_requested', 'Top-up needs review',
    'A top-up of ' || to_char(new.amount, 'FM999,999,990.00') || ' is waiting for approval.',
    '/admin/topups');
  return null;
end;
$$;

create trigger notify_topup_requested
  after insert on public.topup_requests
  for each row
  when (new.status = 'pending')
  execute function public.tg_notify_topup_requested();

-- ===== profiles: registration pending =====
create or replace function public.tg_notify_registration_pending()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  perform public.notify_admins(
    'registration_pending', 'New registration',
    coalesce(nullif(new.full_name, ''), new.email) || ' is waiting to be confirmed.',
    '/admin/users');
  return null;
end;
$$;

create trigger notify_registration_pending
  after insert on public.profiles
  for each row
  when (new.approval_status = 'pending')
  execute function public.tg_notify_registration_pending();

-- ===== orders: entered needs_review =====
create or replace function public.tg_notify_order_needs_review()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  perform public.notify_admins(
    'order_needs_review', 'Order needs review',
    'A payment could not be verified automatically and is waiting for you.',
    '/admin/orders');
  return null;
end;
$$;

-- The guard compares against old.status, and that is what gives both behaviours
-- wanted here. verify-payment can write needs_review more than once for the same
-- order, and a repeat write (needs_review -> needs_review) must not notify twice.
-- An order that leaves the queue and comes back is a genuinely new review, and
-- does notify again. The operator is incidental: orders.status is NOT NULL, so
-- `is distinct from` and `<>` behave identically.
create trigger notify_order_needs_review
  after update of status on public.orders
  for each row
  when (new.status = 'needs_review' and old.status is distinct from 'needs_review')
  execute function public.tg_notify_order_needs_review();

revoke execute on function public.tg_notify_topup_resolved() from public, anon, authenticated;
revoke execute on function public.tg_notify_topup_requested() from public, anon, authenticated;
revoke execute on function public.tg_notify_registration_pending() from public, anon, authenticated;
revoke execute on function public.tg_notify_order_needs_review() from public, anon, authenticated;

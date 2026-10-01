import type { TopupRequest, WalletEntry } from '../types'
import { formatPeso } from './money'

// Mirrors the check constraint on public.topup_requests.amount
// (supabase/migrations/20261001000000_wallet_schema.sql). A typo guard, not a
// policy limit: it stops 50000 being entered for 500.
export const TOPUP_MAX = 10000

export const TOPUP_PRESETS = [100, 200, 500] as const

export function canAfford(balance: number, total: number): boolean {
  // Compared in centavos, not pesos. cartTotal (src/lib/cart.ts) sums unrounded
  // float products, so a cart of 3 x P1.10 arrives as 3.3000000000000003 and a
  // raw `balance >= total` would refuse a customer holding exactly P3.30 — a
  // purchase Postgres numeric(10,2) accepts. Rounding both sides to centavos
  // makes this agree with the database.
  return Math.round(balance * 100) >= Math.round(total * 100)
}

// The message sync_order_wallet raises when its guarded debit finds the balance
// short (supabase/migrations/20261001000200_wallet_payments.sql). It reaches the
// client as the RPC error's `message`, so the checkout screens match on it:
// change the wording there and this must follow, or the friendly message and
// Top up link silently stop appearing.
export const INSUFFICIENT_BALANCE_MESSAGE = 'insufficient wallet balance'

export function isInsufficientBalance(message: string): boolean {
  return message.toLowerCase().includes(INSUFFICIENT_BALANCE_MESSAGE)
}

export interface PayErrorView {
  text: string
  // Where the customer can go from here: Top up for a short balance, My Orders
  // (where cancelling lives) when retrying cannot help.
  link: 'topup' | 'orders' | null
}

// Refusals from pay_order_with_wallet (same migration) that no retry fixes: the
// order itself is the problem, not the moment.
const PERMANENT_REFUSALS = [
  'order not payable',
  'order not found',
  'forbidden',
  'not set to pay from your wallet',
]

// Maps a pay_order_with_wallet failure to what the customer sees. Order matters:
// `insufficient stock for item <uuid>` (raised by sync_order_stock when the
// order flips to paid) must not be mistaken for a short balance, which is why
// this matches the full balance phrase rather than the word "insufficient".
export function describePayError(raw: string): PayErrorView {
  const message = raw.toLowerCase()
  if (isInsufficientBalance(raw)) {
    return { text: 'Not enough balance — top up first.', link: 'topup' }
  }
  if (message.includes('insufficient stock')) {
    return {
      text: 'Someone beat you to it — an item in this order just went out of stock.',
      link: 'orders',
    }
  }
  if (PERMANENT_REFUSALS.some((phrase) => message.includes(phrase))) {
    return { text: raw, link: 'orders' }
  }
  return { text: raw, link: null }
}

export type ParsedAmount =
  | { ok: true; value: number }
  | { ok: false; error: string }

// Deliberately strict. Postgres stores numeric(10,2), so an input like
// "100.555" would be rounded on the way in and leave the client showing an
// amount the database never held. Rejecting at entry keeps what the customer
// typed and what gets credited identical.
const AMOUNT_RE = /^\d+(\.\d{1,2})?$/

export function parseTopupAmount(input: string): ParsedAmount {
  const trimmed = input.trim()
  if (trimmed === '') return { ok: false, error: 'Enter an amount' }
  if (!AMOUNT_RE.test(trimmed)) {
    return { ok: false, error: 'Enter an amount like 250 or 99.50' }
  }
  const value = Number(trimmed)
  if (value <= 0) return { ok: false, error: 'Enter an amount above zero' }
  if (value > TOPUP_MAX) {
    return { ok: false, error: `The most you can top up at once is ${formatPeso(TOPUP_MAX)}` }
  }
  return { ok: true, value }
}

export function rowSign(row: Pick<HistoryRow, 'kind' | 'amount'>): '+' | '−' | '' {
  // Pending and rejected rows carry a positive amount (topup_requests.amount has
  // check `amount > 0`), so a sign derived from the number alone would claim a
  // credit that never happened. Rejected gets no sign at all — no money moved.
  // Pending keeps '+' as a prospective credit. Ledger kinds use the real sign.
  if (row.kind === 'rejected') return ''
  if (row.kind === 'pending') return '+'
  return row.amount < 0 ? '−' : '+'
}

const KIND_LABEL: Record<WalletEntry['kind'], string> = {
  topup: 'Top-up approved',
  purchase: 'Purchase',
  refund: 'Refund',
}

export function entryLabel(entry: WalletEntry): string {
  return entry.note.trim() || KIND_LABEL[entry.kind]
}

export interface HistoryRow {
  id: string
  kind: WalletEntry['kind'] | 'pending' | 'rejected'
  amount: number
  label: string
  detail: string
  created_at: string
}

// Rejected and pending top-ups write no ledger entry, so reading
// wallet_entries alone would make a rejection silently vanish and the
// customer would never learn why. Approved requests ARE in the ledger, so
// they are dropped here to avoid showing the same top-up twice.
export function mergeHistory(
  entries: WalletEntry[],
  requests: TopupRequest[],
): HistoryRow[] {
  const fromEntries: HistoryRow[] = entries.map((e) => ({
    id: e.id,
    kind: e.kind,
    amount: e.amount,
    label: entryLabel(e),
    detail: '',
    created_at: e.created_at,
  }))

  const fromRequests: HistoryRow[] = requests
    .filter((r) => r.status !== 'approved')
    .map((r) => ({
      id: r.id,
      kind: r.status === 'pending' ? ('pending' as const) : ('rejected' as const),
      amount: r.amount,
      label: r.status === 'pending' ? 'Top-up awaiting approval' : 'Top-up rejected',
      detail: r.status === 'rejected' ? r.reject_reason : '',
      created_at: r.created_at,
    }))

  return [...fromEntries, ...fromRequests].sort((a, b) =>
    b.created_at.localeCompare(a.created_at))
}

export interface Item {
  id: string
  name: string
  price: number
  stock: number
  image_url: string | null
  category: string
  low_stock_threshold: number
  is_active: boolean
}

export interface PaymentMethod {
  id: string
  label: string
  type: 'ewallet' | 'bank' | 'cash' | 'wallet'
  qr_image_url: string | null
  account_name: string
  account_number: string
  is_active: boolean
}

export interface AppSettings {
  payment_ai_enabled: boolean
  payment_ai_model: 'claude-haiku-4-5' | 'claude-sonnet-5' | 'claude-opus-4-8'
}

export type OrderStatus =
  | 'awaiting_payment' | 'verifying' | 'paid' | 'needs_review' | 'cancelled'

export interface AiVerdict {
  verdict: 'pass' | 'fail' | 'unsure'
  extracted: {
    amount: number | null
    recipient: string | null
    reference: string | null
    timestamp: string | null
  }
  reason: string
}

export interface Order {
  id: string
  user_id: string
  total: number
  status: OrderStatus
  payment_method_id: string | null
  receipt_image_url: string | null
  ai_verdict: AiVerdict | null
  created_at: string
}

export interface OrderItem {
  order_id: string
  item_id: string
  qty: number
  price_at_purchase: number
}

export interface RestockDetection {
  matched_item_id: string | null
  name: string
  qty: number
  suggested_price: number | null
  confidence: 'high' | 'medium' | 'low'
}

export interface RestockSession {
  id: string
  admin_id: string
  photo_url: string
  ai_result: { detections: RestockDetection[] } | null
  status: 'pending_review' | 'applied' | 'discarded'
  created_at: string
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected'

export interface AllowedDomain {
  id: string
  domain: string
  note: string
  created_at: string
}

export interface PendingRegistration {
  id: string
  email: string
  full_name: string
  first_name: string
  last_name: string
  created_at: string
}

export interface CartLine {
  item: Item
  qty: number
}

export interface Wallet {
  user_id: string
  balance: number
  updated_at: string
}

export type WalletEntryKind = 'topup' | 'purchase' | 'refund'

export interface WalletEntry {
  id: string
  user_id: string
  amount: number
  kind: WalletEntryKind
  order_id: string | null
  topup_id: string | null
  note: string
  created_at: string
}

export type TopupStatus = 'pending' | 'approved' | 'rejected'

export interface TopupRequest {
  id: string
  user_id: string
  amount: number
  payment_method_id: string | null
  proof_path: string
  status: TopupStatus
  reviewed_by: string | null
  reviewed_at: string | null
  reject_reason: string
  created_at: string
}

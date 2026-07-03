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
  type: 'ewallet' | 'bank'
  qr_image_url: string
  account_name: string
  account_number: string
  is_active: boolean
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

export interface CartLine {
  item: Item
  qty: number
}

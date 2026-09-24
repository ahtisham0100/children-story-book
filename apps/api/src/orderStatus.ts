export const ORDER_STATUS = {
  awaitingPayment: "awaiting_payment",
  paid: "paid",
  pdfReady: "pdf_ready",
  submittedToPrint: "submitted_to_print",
  processing: "processing",
  dispatched: "dispatched",
  delivered: "delivered",
  failed: "failed",
  cancelled: "cancelled",
} as const;

export type OrderStatus = (typeof ORDER_STATUS)[keyof typeof ORDER_STATUS];

/**
 * Stripe redelivers webhooks (at-least-once delivery), so payment_intent.succeeded
 * can arrive more than once for the same order. Only the FIRST delivery should
 * move the order forward — everything after that is a no-op, not an error.
 */
export function canTransitionToPaid(current: OrderStatus): boolean {
  return current === ORDER_STATUS.awaitingPayment;
}

/**
 * Gelato's own status vocabulary, mapped onto ours. Returns null (rather than
 * throwing or guessing) for anything unrecognized, so a webhook route can log
 * and store the raw event without corrupting order.status.
 *
 * NOTE: written from Gelato's commonly-documented order-status vocabulary.
 * Confirm the exact strings their webhook actually sends against a real
 * test-mode order once API access exists (see the post-build checklist) and
 * extend this map if any are missing.
 */
const GELATO_STATUS_MAP: Record<string, OrderStatus> = {
  created: ORDER_STATUS.submittedToPrint,
  in_production: ORDER_STATUS.processing,
  printed: ORDER_STATUS.processing,
  shipped: ORDER_STATUS.dispatched,
  delivered: ORDER_STATUS.delivered,
  cancelled: ORDER_STATUS.cancelled,
  failed: ORDER_STATUS.failed,
};

export function mapGelatoStatus(gelatoStatus: string): OrderStatus | null {
  return GELATO_STATUS_MAP[gelatoStatus] ?? null;
}

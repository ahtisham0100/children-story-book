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

/**
 * Manual status changes an admin may make (POST /api/admin/orders/:id/status).
 * Deliberately narrow: an admin corrects the print/shipping lifecycle when a
 * Gelato webhook never arrived, or closes out an order. Nothing here moves an
 * order back into payment or pre-print states:
 *  - failed -> paid happens only as part of a fulfilment retry
 *    (src/admin/fulfillmentRetry.ts), which also re-runs the job;
 *  - -> submitted_to_print happens only through Gelato reconciliation, which
 *    records the Gelato order id at the same time.
 * delivered and cancelled are final. Setting delivered stamps deliveredAt
 * (src/orderStatusUpdate.ts), which starts the GDPR Pathway 2 clock.
 * Cancelling a paid order does NOT refund it; refunds happen in Stripe.
 */
export const ADMIN_STATUS_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  [ORDER_STATUS.awaitingPayment]: [ORDER_STATUS.cancelled],
  [ORDER_STATUS.paid]: [ORDER_STATUS.failed],
  [ORDER_STATUS.pdfReady]: [ORDER_STATUS.failed],
  [ORDER_STATUS.submittedToPrint]: [
    ORDER_STATUS.processing,
    ORDER_STATUS.dispatched,
    ORDER_STATUS.delivered,
    ORDER_STATUS.failed,
    ORDER_STATUS.cancelled,
  ],
  [ORDER_STATUS.processing]: [ORDER_STATUS.dispatched, ORDER_STATUS.delivered, ORDER_STATUS.failed, ORDER_STATUS.cancelled],
  [ORDER_STATUS.dispatched]: [ORDER_STATUS.delivered, ORDER_STATUS.failed],
  [ORDER_STATUS.delivered]: [],
  [ORDER_STATUS.failed]: [ORDER_STATUS.cancelled],
  [ORDER_STATUS.cancelled]: [],
};

/** The statuses an admin may move an order to from `from` ([] for final or unknown statuses). */
export function adminTransitionsFrom(from: string): readonly OrderStatus[] {
  return Object.prototype.hasOwnProperty.call(ADMIN_STATUS_TRANSITIONS, from)
    ? ADMIN_STATUS_TRANSITIONS[from as OrderStatus]
    : [];
}

export function canAdminTransition(from: string, to: string): boolean {
  return adminTransitionsFrom(from).includes(to as OrderStatus);
}

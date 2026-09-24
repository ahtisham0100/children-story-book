import { ORDER_STATUS } from "../orderStatus";

/**
 * GDPR deletion due dates: the ONE place the policy lives. The sweeper
 * (sweeper.ts) re-checks every SQL candidate against this before deleting, and
 * GET /api/account/my-data shows the same dates to the customer, so the two can
 * never disagree. Policy (confirmed with the client, see
 * docs/superpowers/specs/2026-09-24-gdpr-deletion-design.md):
 *
 *  - P1, no paid order: raw uploads deleted when now > expiresAt + 24h.
 *    Rendered previews are KEPT (future: reminder emails, then deletion).
 *  - P2, delivered: raw deleted when now > deliveredAt + 24h, processed files
 *    (pages, preview, print PDF) when now > deliveredAt + 30 days.
 *  - Anything else ordered (in production, dispatched, failed awaiting an
 *    admin): held. Nothing is deleted under an order that may still need it.
 */

const HOUR_MS = 3_600_000;
export const P1_GRACE_MS = 24 * HOUR_MS;
export const P2_RAW_DELAY_MS = 24 * HOUR_MS;
export const P2_PROCESSED_DELAY_MS = 30 * 24 * HOUR_MS;

/**
 * Order statuses that DON'T make a session "ordered": an abandoned checkout
 * (the Order row exists from the moment the checkout form is submitted) and a
 * cancelled order. A session referenced only by these follows Pathway 1.
 */
export const UNORDERED_STATUSES: readonly string[] = [ORDER_STATUS.awaitingPayment, ORDER_STATUS.cancelled];

/**
 * Statuses that hold a session's files even when another order for it has been
 * delivered: the book is still being made or shipped, or fulfilment failed and
 * an admin may retry it (which re-renders from the raw photo).
 */
export const HOLDING_STATUSES: readonly string[] = [
  ORDER_STATUS.paid,
  ORDER_STATUS.pdfReady,
  ORDER_STATUS.submittedToPrint,
  ORDER_STATUS.processing,
  ORDER_STATUS.dispatched,
  ORDER_STATUS.failed,
];

export interface ScheduleSession {
  expiresAt: Date;
  rawDeletedAt: Date | null;
  processedDeletedAt: Date | null;
}

export interface ScheduleOrder {
  status: string;
  deliveredAt: Date | null;
}

export type DeletionPathway = "p1" | "p2" | "held";

export interface DeletionSchedule {
  pathway: DeletionPathway;
  /** When raw uploads become due, or null if they aren't scheduled. */
  rawDueAt: Date | null;
  /** When processed files become due, or null if they aren't scheduled. */
  processedDueAt: Date | null;
}

const plus = (date: Date, ms: number) => new Date(date.getTime() + ms);

/** `orders` = every order with an item referencing this session. */
export function deletionSchedule(session: ScheduleSession, orders: ScheduleOrder[]): DeletionSchedule {
  const ordered = orders.filter((o) => !UNORDERED_STATUSES.includes(o.status));
  if (ordered.length === 0) {
    return { pathway: "p1", rawDueAt: plus(session.expiresAt, P1_GRACE_MS), processedDueAt: null };
  }

  const holding = ordered.some((o) => HOLDING_STATUSES.includes(o.status));
  const deliveries = ordered
    .filter((o) => o.status === ORDER_STATUS.delivered && o.deliveredAt)
    .map((o) => o.deliveredAt!.getTime());
  // "delivered" with no deliveredAt (shouldn't happen after the backfill) is
  // held rather than guessed at: no anchor, no deletion.
  const allDeliveredHaveDate = ordered.every((o) => o.status !== ORDER_STATUS.delivered || o.deliveredAt);
  if (holding || deliveries.length === 0 || !allDeliveredHaveDate) {
    return { pathway: "held", rawDueAt: null, processedDueAt: null };
  }

  const anchor = new Date(Math.max(...deliveries));
  return {
    pathway: "p2",
    rawDueAt: plus(anchor, P2_RAW_DELAY_MS),
    processedDueAt: plus(anchor, P2_PROCESSED_DELAY_MS),
  };
}

/** Strictly after the due time (the policy says "now > due"). */
export function isRawDue(session: ScheduleSession, schedule: DeletionSchedule, now: Date): boolean {
  return !session.rawDeletedAt && schedule.rawDueAt !== null && now.getTime() > schedule.rawDueAt.getTime();
}

export function isProcessedDue(session: ScheduleSession, schedule: DeletionSchedule, now: Date): boolean {
  return (
    !session.processedDeletedAt &&
    schedule.processedDueAt !== null &&
    now.getTime() > schedule.processedDueAt.getTime()
  );
}

/**
 * Non-null once GDPR deletion has run for a session: upload and render routes
 * then answer 410 with this message. Letting a new upload or render in after
 * the marker is set would create files the sweeper never looks at again.
 */
export function filesDeletedMessage(session: {
  rawDeletedAt: Date | null;
  processedDeletedAt: Date | null;
}): string | null {
  return session.rawDeletedAt || session.processedDeletedAt
    ? "This book's photos have been deleted under our data retention policy. Please start a new book."
    : null;
}

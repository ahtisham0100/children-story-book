import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { stripe } from "../stripeClient";
import { ORDER_STATUS } from "../orderStatus";
import { deleteSessionAssets } from "./deleteSessionAssets";
import { deletionSchedule } from "./schedule";

/**
 * GDPR Pathway 3: a logged-in customer deletes their data
 * (DELETE /api/account/my-data). Immediate and irreversible.
 *
 * Order of operations, chosen so a failure at any step leaves a state that is
 * safe to retry and never a half-anonymised account with files still in R2:
 *   1. Refuse (409) while any paid order is still being made: deleting its
 *      photos would break a book the customer has paid for.
 *   2. Cancel open Stripe PaymentIntents for abandoned checkouts, so a late
 *      payment can't charge for a book we can no longer make. Refuse (503) if
 *      Stripe can't confirm that.
 *   3. Delete every linked session's R2 files (deleteSessionAssets, scope all).
 *   4. One DB transaction: delete Session/Character rows, anonymise orders,
 *      delete tokens, login sessions and the Customer, write the audit row.
 *
 * LIMITATION: Session has no customerId. Only sessions reachable through the
 * customer's orders are found here; previews they never ordered are unlinkable
 * and are handled by Pathway 1 (raw photos deleted 24h after expiry).
 */

/** Paid but not yet dispatched: deletion is refused while any order is in one of these. */
export const UNDISPATCHED_PAID_STATUSES: readonly string[] = [
  ORDER_STATUS.paid,
  ORDER_STATUS.pdfReady,
  ORDER_STATUS.submittedToPrint,
  ORDER_STATUS.processing,
];

export type AccountDeletionResult =
  | { kind: "blocked"; orders: { id: string; status: string }[] }
  | { kind: "payment_in_flight"; orderIds: string[] }
  | { kind: "stripe_unavailable" }
  | {
      kind: "deleted";
      sessionsDeleted: number;
      fileCount: number;
      ordersAnonymised: number;
      /** Sessions also used by another customer's order: left alone. */
      sessionsKeptShared: number;
    };

// PaymentIntent states in which money has moved or is moving: the order is
// about to become "paid", so it must be treated like one.
const PAYMENT_IN_FLIGHT = new Set(["succeeded", "processing", "requires_capture"]);

type SnapshotEntry = Record<string, unknown>;
function anonymisedSnapshot(snapshot: Prisma.JsonValue): Prisma.InputJsonValue {
  if (!Array.isArray(snapshot)) return [];
  return snapshot.map((entry) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? { ...(entry as SnapshotEntry), childName: "", rawKey: null }
      : null,
  ) as Prisma.InputJsonValue;
}

export async function deleteCustomerData(customerId: string): Promise<AccountDeletionResult> {
  const orders = await prisma.order.findMany({ where: { customerId }, include: { items: true } });

  // 1. Never pull the photos out from under a book that's being made.
  const inFlight = orders.filter((o) => UNDISPATCHED_PAID_STATUSES.includes(o.status));
  if (inFlight.length > 0) {
    return { kind: "blocked", orders: inFlight.map((o) => ({ id: o.id, status: o.status })) };
  }

  // 2. Abandoned checkouts: make sure no payment can still land.
  const abandoned = orders.filter((o) => o.status === ORDER_STATUS.awaitingPayment);
  const paymentInFlight: string[] = [];
  try {
    for (const order of abandoned) {
      if (!order.stripePaymentIntentId) continue;
      const intent = await stripe.paymentIntents.retrieve(order.stripePaymentIntentId);
      if (intent.status === "canceled") continue;
      if (PAYMENT_IN_FLIGHT.has(intent.status)) {
        paymentInFlight.push(order.id);
        continue;
      }
      await stripe.paymentIntents.cancel(order.stripePaymentIntentId);
    }
  } catch (error) {
    console.error(
      `[gdpr] account deletion for customer ${customerId}: couldn't cancel an open PaymentIntent:`,
      error instanceof Error ? error.message : String(error),
    );
    return { kind: "stripe_unavailable" };
  }
  if (paymentInFlight.length > 0) return { kind: "payment_in_flight", orderIds: paymentInFlight };

  // 3. R2 first. A session another customer's order also references is left
  // alone: deleting it would destroy THEIR book's files.
  const orderIds = orders.map((o) => o.id);
  const mySessionIds = [...new Set(orders.flatMap((o) => o.items.map((i) => i.sessionId)))];
  const sharedItems = await prisma.orderItem.findMany({
    where: { sessionId: { in: mySessionIds }, orderId: { notIn: orderIds } },
    select: { sessionId: true },
  });
  const shared = new Set(sharedItems.map((i) => i.sessionId));
  const sessionIds = mySessionIds.filter((id) => !shared.has(id));
  if (shared.size > 0) {
    console.warn(`[gdpr] account deletion for customer ${customerId}: kept ${shared.size} session(s) shared with another order.`);
  }

  let fileCount = 0;
  for (const sessionId of sessionIds) {
    // Not automated, so GDPR_DELETION_DRY_RUN doesn't apply: the customer
    // asked for this and it happens now. Throws on failure (step 4 never runs).
    const result = await deleteSessionAssets(sessionId, { scope: "all", trigger: "user", actor: customerId, dryRun: false });
    fileCount += result.fileCount;
  }

  // 4. DB. If this fails, R2 is already clean and a retry re-runs step 3 as a
  // no-op (fileCount 0) and then this transaction.
  const now = new Date();
  try {
    await prisma.$transaction(async (tx) => {
      await tx.character.deleteMany({ where: { sessionId: { in: sessionIds } } });
      await tx.session.deleteMany({ where: { id: { in: sessionIds } } });

      for (const order of orders) {
        const cancel = order.status === ORDER_STATUS.awaitingPayment;
        await tx.order.update({
          where: { id: order.id },
          data: {
            email: "",
            shippingName: "",
            shippingLine1: "",
            shippingLine2: null,
            shippingCity: "",
            shippingPostalCode: "",
            // shippingCountry is kept on purpose: it's needed for VAT
            // accounting and doesn't identify anyone on its own.
            customerId: null,
            anonymisedAt: now,
            ...(cancel ? { status: ORDER_STATUS.cancelled } : {}),
          },
        });
        if (cancel) {
          await tx.orderStatusEvent.create({
            data: { orderId: order.id, status: ORDER_STATUS.cancelled, source: "gdpr_account_deletion" },
          });
        }
        for (const item of order.items) {
          await tx.orderItem.update({
            where: { id: item.id },
            data: {
              configSnapshot: anonymisedSnapshot(item.configSnapshot),
              ...(shared.has(item.sessionId) ? {} : { printPdfKey: null }),
            },
          });
        }
      }
      // Raw webhook bodies carry the email (Stripe) and possibly the address
      // (Gelato). Status, source and time stay for the order history.
      await tx.orderStatusEvent.updateMany({ where: { orderId: { in: orderIds } }, data: { raw: Prisma.DbNull } });

      await tx.authToken.deleteMany({ where: { customerId } });
      await tx.customerSession.deleteMany({ where: { customerId } });
      await tx.customer.delete({ where: { id: customerId } });

      await tx.deletionAuditLog.create({
        data: {
          trigger: "user",
          scope: "account",
          sessionId: null,
          fileCount,
          actor: customerId,
          dryRun: false,
          outcome: "succeeded",
          error: null,
        },
      });
    });
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    await prisma.deletionAuditLog
      .create({
        data: { trigger: "user", scope: "account", sessionId: null, fileCount, actor: customerId, dryRun: false, outcome: "failed", error: message },
      })
      .catch(() => undefined);
    throw error;
  }

  return {
    kind: "deleted",
    sessionsDeleted: sessionIds.length,
    fileCount,
    ordersAnonymised: orders.length,
    sessionsKeptShared: shared.size,
  };
}

export interface MyDataItem {
  id: string;
  sessionId: string;
  bookTitle: string;
  photos: "stored" | "deleted";
  bookFiles: "stored" | "deleted";
  photosDeletionDueAt: string | null;
  bookFilesDeletionDueAt: string | null;
}

export interface MyDataOrder {
  id: string;
  status: string;
  createdAt: string;
  deliveredAt: string | null;
  items: MyDataItem[];
}

/** What GET /api/account/my-data shows: per order item, photo status and scheduled deletion dates. */
export async function customerDataStatus(customerId: string): Promise<MyDataOrder[]> {
  const orders = await prisma.order.findMany({
    where: { customerId },
    include: { items: true },
    orderBy: { createdAt: "desc" },
  });
  const sessionIds = [...new Set(orders.flatMap((o) => o.items.map((i) => i.sessionId)))];
  const sessions = await prisma.session.findMany({
    where: { id: { in: sessionIds } },
    select: { id: true, expiresAt: true, rawDeletedAt: true, processedDeletedAt: true },
  });
  const sessionById = new Map(sessions.map((s) => [s.id, s]));

  // The schedule depends on EVERY order using the session, not only this
  // customer's; only statuses and dates are read from those.
  const allItems = await prisma.orderItem.findMany({
    where: { sessionId: { in: sessionIds } },
    select: { sessionId: true, orderId: true },
  });
  const relatedOrders = await prisma.order.findMany({
    where: { id: { in: [...new Set(allItems.map((i) => i.orderId))] } },
    select: { id: true, status: true, deliveredAt: true },
  });
  const orderById = new Map(relatedOrders.map((o) => [o.id, o]));

  const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

  return orders.map((order) => ({
    id: order.id,
    status: order.status,
    createdAt: order.createdAt.toISOString(),
    deliveredAt: iso(order.deliveredAt),
    items: order.items.map((item) => {
      const session = sessionById.get(item.sessionId);
      if (!session) {
        return {
          id: item.id,
          sessionId: item.sessionId,
          bookTitle: item.bookTitle,
          photos: "deleted" as const,
          bookFiles: "deleted" as const,
          photosDeletionDueAt: null,
          bookFilesDeletionDueAt: null,
        };
      }
      const ordersForSession = allItems
        .filter((i) => i.sessionId === item.sessionId)
        .map((i) => orderById.get(i.orderId))
        .filter((o): o is NonNullable<typeof o> => o !== undefined);
      const schedule = deletionSchedule(session, ordersForSession);
      return {
        id: item.id,
        sessionId: item.sessionId,
        bookTitle: item.bookTitle,
        photos: session.rawDeletedAt ? ("deleted" as const) : ("stored" as const),
        bookFiles: session.processedDeletedAt ? ("deleted" as const) : ("stored" as const),
        photosDeletionDueAt: iso(schedule.rawDueAt),
        bookFilesDeletionDueAt: iso(schedule.processedDueAt),
      };
    }),
  }));
}

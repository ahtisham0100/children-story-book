import { prisma } from "../db";
import { enqueueFulfillment, getFulfillmentQueue } from "../queue";
import { ORDER_STATUS } from "../orderStatus";

/**
 * A previous fulfilment attempt called Gelato and we don't know whether an
 * order was created (src/fulfillment.ts ensureSubmittedToGelato). Retrying the
 * job can't help: it stops on the same UnrecoverableError until an admin
 * reconciles (POST /api/admin/orders/:id/gelato-reconcile).
 */
export function hasUnknownGelatoOutcome(
  order: { gelatoSubmitStartedAt: Date | null; gelatoOrderId: string | null } | null,
): boolean {
  return !!order && order.gelatoSubmitStartedAt !== null && order.gelatoOrderId === null;
}

/**
 * markFulfillmentFailed sets an order to "failed", but fulfilment only moves
 * the status forward from "paid"/"pdf_ready". Without this, a retried job that
 * then succeeds would leave the order showing "failed" (and held from GDPR
 * deletion forever). Only while no print order exists: once Gelato has it, the
 * status belongs to Gelato. Returns true if the order was reset.
 */
export async function resetFailedOrderForRetry(orderId: string, adminId: string): Promise<boolean> {
  const moved = await prisma.order.updateMany({
    where: { id: orderId, status: ORDER_STATUS.failed, gelatoOrderId: null },
    data: { status: ORDER_STATUS.paid },
  });
  if (moved.count === 0) return false;
  await prisma.orderStatusEvent.create({
    data: {
      orderId,
      status: ORDER_STATUS.paid,
      source: "admin",
      raw: { note: "Reset from failed so a fulfilment retry can complete the order.", adminId },
    },
  });
  return true;
}

export type FulfillmentRequeue = "retried" | "enqueued" | "already_queued";

/**
 * Gets fulfilment running again for an order: retry its failed job (jobId =
 * orderId, with a fresh set of attempts), leave a waiting/active one alone, or
 * enqueue a new one. A completed job is removed first: enqueueFulfillment
 * dedups on jobId and would otherwise silently do nothing.
 */
export async function retryOrEnqueueFulfillment(orderId: string): Promise<FulfillmentRequeue> {
  const job = await getFulfillmentQueue().getJob(orderId);
  if (job) {
    if (await job.isFailed()) {
      await job.retry("failed", { resetAttemptsMade: true });
      return "retried";
    }
    if (!(await job.isCompleted())) return "already_queued";
    await job.remove();
  }
  await enqueueFulfillment(orderId);
  return "enqueued";
}

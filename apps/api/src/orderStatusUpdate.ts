import type { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { mapGelatoStatus, ORDER_STATUS, type OrderStatus } from "./orderStatus";

/**
 * The code paths that change an order's status from OUTSIDE fulfilment:
 * Gelato (webhook and admin sync share applyGelatoStatus) and an admin's
 * manual change (applyOrderStatus). Both write an OrderStatusEvent and both
 * stamp deliveredAt through stampDeliveredAt, so GDPR Pathway 2 has one anchor
 * rule wherever "delivered" comes from.
 */

export type StatusEventSource = "gelato_webhook" | "gelato_sync" | "admin";

/**
 * GDPR Pathway 2 anchors on the FIRST delivery report. The deliveredAt IS
 * NULL condition makes a repeated "delivered" (a re-sent webhook, a sync after
 * a webhook, an admin re-setting it) a no-op, so the deletion date can never
 * be pushed back (src/gdpr/schedule.ts).
 */
async function stampDeliveredAt(orderId: string): Promise<void> {
  await prisma.order.updateMany({ where: { id: orderId, deliveredAt: null }, data: { deliveredAt: new Date() } });
}

/**
 * Applies a Gelato status to an order: the Gelato webhook's logic, also used
 * by POST /api/admin/orders/:id/gelato-sync. The event is always stored (with
 * the raw Gelato status if it's unrecognised); the order's status only changes
 * for a status mapGelatoStatus knows. Returns the mapped status, or null.
 */
export async function applyGelatoStatus(
  orderId: string,
  gelatoStatus: string,
  raw: Prisma.InputJsonValue,
  source: "gelato_webhook" | "gelato_sync",
): Promise<OrderStatus | null> {
  const mapped = mapGelatoStatus(gelatoStatus);
  await prisma.orderStatusEvent.create({
    data: { orderId, status: mapped ?? gelatoStatus, source, raw },
  });
  if (mapped) {
    await prisma.order.update({ where: { id: orderId }, data: { status: mapped } });
    if (mapped === ORDER_STATUS.delivered) await stampDeliveredAt(orderId);
  }
  return mapped;
}

/**
 * A status change conditional on the status the caller saw, so a concurrent
 * change (a webhook landing between the admin's page load and click) is never
 * silently overwritten. Returns false, writing nothing, if the order has moved.
 * Transition rules are the caller's job (canAdminTransition).
 */
export async function applyOrderStatus(
  orderId: string,
  expectedStatus: string,
  status: OrderStatus,
  source: StatusEventSource,
  raw?: Prisma.InputJsonValue,
): Promise<boolean> {
  const moved = await prisma.order.updateMany({ where: { id: orderId, status: expectedStatus }, data: { status } });
  if (moved.count === 0) return false;
  await prisma.orderStatusEvent.create({ data: { orderId, status, source, raw } });
  if (status === ORDER_STATUS.delivered) await stampDeliveredAt(orderId);
  return true;
}

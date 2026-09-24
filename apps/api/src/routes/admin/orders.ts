import type { FastifyInstance } from "fastify";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../db";
import { env } from "../../env";
import { getFulfillmentQueue } from "../../queue";
import { adminTransitionsFrom, canAdminTransition, ORDER_STATUS, type OrderStatus } from "../../orderStatus";
import { applyGelatoStatus, applyOrderStatus } from "../../orderStatusUpdate";
import { getGelatoOrder } from "../../print/gelato";
import { redact } from "../../admin/redact";
import { logAdminAction } from "../../admin/audit";
import { currentAdmin } from "../../admin/plugin";
import {
  hasUnknownGelatoOutcome,
  resetFailedOrderForRetry,
  retryOrEnqueueFulfillment,
} from "../../admin/fulfillmentRetry";
import { dateRange, INVALID_DATE, iso, NO_REDIS, PageQuery, pageWindow } from "./common";

const StatusLiteral = Type.Union(Object.values(ORDER_STATUS).map((s) => Type.Literal(s)));
const OrderParams = Type.Object({ id: Type.String({ format: "uuid" }) });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function eventNote(source: string, raw: Prisma.JsonValue): string | null {
  if (source !== "admin" || !raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const note = (raw as { note?: unknown }).note;
  return typeof note === "string" && note ? note : null;
}

async function fulfillmentJobState(orderId: string) {
  if (!env.REDIS_URL) return null;
  try {
    const job = await getFulfillmentQueue().getJob(orderId);
    if (!job) return null;
    return {
      state: await job.getState(),
      attemptsMade: job.attemptsMade ?? 0,
      failedReason: job.failedReason ? redact(job.failedReason) : null,
    };
  } catch (error) {
    // The order page must still load when Redis is unreachable.
    console.warn(`[admin] order ${orderId}: couldn't read the fulfilment job:`, error instanceof Error ? error.message : String(error));
    return null;
  }
}

/**
 * Order tracker. Admins see emails and addresses (support needs them); raw
 * webhook bodies are still not returned (they're for audit, and Stripe's
 * holds card-adjacent metadata). Status changes go through
 * src/orderStatusUpdate.ts, the same path as the Gelato webhook.
 */
export async function registerAdminOrderRoutes(app: FastifyInstance) {
  const api = app.withTypeProvider<TypeBoxTypeProvider>();

  api.get(
    "/api/admin/orders",
    {
      schema: {
        tags: ["admin"],
        querystring: Type.Object({
          status: Type.Optional(StatusLiteral),
          from: Type.Optional(Type.String({ maxLength: 40 })),
          to: Type.Optional(Type.String({ maxLength: 40 })),
          q: Type.Optional(Type.String({ maxLength: 200 })),
          ...PageQuery,
        }),
      },
    },
    async (request, reply) => {
      const { status, from, to, page, limit } = request.query;
      const createdAt = dateRange(from, to);
      if (createdAt === "invalid") return reply.code(400).send(INVALID_DATE);

      const q = request.query.q?.trim();
      const where: Prisma.OrderWhereInput = {
        ...(status ? { status } : {}),
        ...(createdAt ? { createdAt } : {}),
        ...(q
          ? UUID.test(q)
            ? { id: q.toLowerCase() }
            : { OR: [{ email: { contains: q, mode: "insensitive" } }, { id: { startsWith: q.toLowerCase() } }] }
          : {}),
      };
      const [total, orders] = await Promise.all([
        prisma.order.count({ where }),
        prisma.order.findMany({
          where,
          orderBy: { createdAt: "desc" },
          ...pageWindow(page, limit),
          select: {
            id: true,
            email: true,
            status: true,
            totalCents: true,
            currency: true,
            createdAt: true,
            gelatoOrderId: true,
            anonymisedAt: true,
            items: { select: { id: true } },
          },
        }),
      ]);
      return {
        items: orders.map((o) => ({
          id: o.id,
          email: o.email,
          status: o.status,
          totalCents: o.totalCents,
          currency: o.currency,
          createdAt: o.createdAt.toISOString(),
          itemCount: o.items.length,
          gelatoOrderId: o.gelatoOrderId,
          anonymisedAt: iso(o.anonymisedAt),
        })),
        page,
        limit,
        total,
      };
    },
  );

  api.get(
    "/api/admin/orders/:id",
    { schema: { tags: ["admin"], params: OrderParams } },
    async (request, reply) => {
      const order = await prisma.order.findUnique({
        where: { id: request.params.id },
        include: { items: true, statusEvents: { orderBy: { createdAt: "asc" } } },
      });
      if (!order) return reply.code(404).send({ message: "Order not found." });
      return {
        id: order.id,
        email: order.email,
        status: order.status,
        totalCents: order.totalCents,
        currency: order.currency,
        createdAt: order.createdAt.toISOString(),
        customerId: order.customerId,
        stripePaymentIntentId: order.stripePaymentIntentId,
        shipping: {
          name: order.shippingName,
          line1: order.shippingLine1,
          line2: order.shippingLine2,
          city: order.shippingCity,
          postalCode: order.shippingPostalCode,
          country: order.shippingCountry,
        },
        gelatoOrderId: order.gelatoOrderId,
        gelatoSubmitStartedAt: iso(order.gelatoSubmitStartedAt),
        deliveredAt: iso(order.deliveredAt),
        anonymisedAt: iso(order.anonymisedAt),
        items: order.items.map((i) => ({
          id: i.id,
          bookTitle: i.bookTitle,
          priceCents: i.priceCents,
          sessionId: i.sessionId,
          hasPrintPdf: !!i.printPdfKey,
        })),
        statusEvents: order.statusEvents.map((e) => ({
          status: e.status,
          source: e.source,
          createdAt: e.createdAt.toISOString(),
          note: eventNote(e.source, e.raw),
        })),
        allowedTransitions: adminTransitionsFrom(order.status),
        gelatoUnknownOutcome: hasUnknownGelatoOutcome(order),
        fulfillmentJob: await fulfillmentJobState(order.id),
      };
    },
  );

  api.post(
    "/api/admin/orders/:id/status",
    {
      schema: {
        tags: ["admin"],
        params: OrderParams,
        body: Type.Object({ status: StatusLiteral, note: Type.String({ maxLength: 500, default: "" }) }),
      },
    },
    async (request, reply) => {
      const admin = currentAdmin(request);
      const { id } = request.params;
      const to = request.body.status as OrderStatus;
      const note = request.body.note.trim();
      const order = await prisma.order.findUnique({ where: { id }, select: { status: true } });
      if (!order) return reply.code(404).send({ message: "Order not found." });
      if (!canAdminTransition(order.status, to)) {
        return reply.code(409).send({
          message: `An order can't be moved from ${order.status} to ${to} by hand.`,
          allowed: adminTransitionsFrom(order.status),
        });
      }
      const applied = await applyOrderStatus(id, order.status, to, "admin", { note, adminId: admin.id });
      if (!applied) {
        return reply
          .code(409)
          .send({ message: "This order's status changed while you were looking at it. Reload and try again." });
      }
      await logAdminAction({
        adminId: admin.id,
        action: "order.status",
        targetType: "order",
        targetId: id,
        before: { status: order.status },
        after: { status: to },
        note,
      });
      const updated = await prisma.order.findUnique({ where: { id }, select: { status: true, deliveredAt: true } });
      return { id, status: updated?.status ?? to, deliveredAt: iso(updated?.deliveredAt) };
    },
  );

  api.post(
    "/api/admin/orders/:id/gelato-sync",
    { schema: { tags: ["admin"], params: OrderParams } },
    async (request, reply) => {
      const admin = currentAdmin(request);
      const { id } = request.params;
      const order = await prisma.order.findUnique({ where: { id }, select: { status: true, gelatoOrderId: true } });
      if (!order) return reply.code(404).send({ message: "Order not found." });
      if (!order.gelatoOrderId) {
        return reply.code(409).send({ message: "This order hasn't been submitted to Gelato (no Gelato order id)." });
      }
      if (!env.GELATO_API_KEY) return reply.code(503).send({ message: "GELATO_API_KEY isn't configured." });

      let gelatoStatus: string;
      try {
        ({ status: gelatoStatus } = await getGelatoOrder(order.gelatoOrderId));
      } catch (error) {
        return reply
          .code(502)
          .send({ message: `Couldn't read the order from Gelato: ${error instanceof Error ? error.message : String(error)}` });
      }
      // The webhook's own code path (src/orderStatusUpdate.ts), so a sync and
      // a webhook can never disagree about what a Gelato status means.
      const mapped = await applyGelatoStatus(
        id,
        gelatoStatus,
        { gelatoStatus, gelatoOrderId: order.gelatoOrderId, syncedBy: admin.id },
        "gelato_sync",
      );
      const status = mapped ?? order.status;
      await logAdminAction({
        adminId: admin.id,
        action: "order.gelato_sync",
        targetType: "order",
        targetId: id,
        before: { status: order.status },
        after: { status, gelatoStatus },
      });
      return { gelatoStatus, applied: mapped !== null, status };
    },
  );

  api.post(
    "/api/admin/orders/:id/gelato-reconcile",
    {
      schema: {
        tags: ["admin"],
        params: OrderParams,
        body: Type.Object({
          gelatoOrderId: Type.Optional(Type.String({ minLength: 1, maxLength: 100, pattern: "^[A-Za-z0-9_-]+$" })),
          clearSubmitMarker: Type.Optional(Type.Literal(true)),
        }),
      },
    },
    async (request, reply) => {
      const admin = currentAdmin(request);
      const { id } = request.params;
      const { gelatoOrderId, clearSubmitMarker } = request.body;
      if ((gelatoOrderId === undefined) === (clearSubmitMarker === undefined)) {
        return reply
          .code(400)
          .send({ message: "Send exactly one of gelatoOrderId (it exists at Gelato) or clearSubmitMarker: true (it doesn't)." });
      }
      // Checked before changing anything: reconciling without being able to
      // re-run fulfilment would leave the order half-fixed.
      if (!env.REDIS_URL) return reply.code(503).send(NO_REDIS);

      const order = await prisma.order.findUnique({
        where: { id },
        select: { status: true, gelatoOrderId: true, gelatoSubmitStartedAt: true },
      });
      if (!order) return reply.code(404).send({ message: "Order not found." });
      if (!hasUnknownGelatoOutcome(order)) {
        return reply
          .code(409)
          .send({ message: "Nothing to reconcile: this order has no Gelato submission with an unknown outcome." });
      }

      if (gelatoOrderId) {
        // Gelato has it: record the id (fulfilment then skips submission, see
        // ensureSubmittedToGelato) and move the order on, as fulfilment would have.
        await prisma.order.update({ where: { id }, data: { gelatoOrderId } });
        const moved = await prisma.order.updateMany({
          where: { id, status: { in: [ORDER_STATUS.paid, ORDER_STATUS.pdfReady, ORDER_STATUS.failed] } },
          data: { status: ORDER_STATUS.submittedToPrint },
        });
        if (moved.count > 0) {
          await prisma.orderStatusEvent.create({
            data: {
              orderId: id,
              status: ORDER_STATUS.submittedToPrint,
              source: "admin",
              raw: { note: "Gelato order recorded by an admin during reconciliation.", gelatoOrderId, adminId: admin.id },
            },
          });
        }
      } else {
        // Gelato doesn't have it: clearing the marker lets fulfilment submit again.
        await prisma.order.update({ where: { id }, data: { gelatoSubmitStartedAt: null } });
        await resetFailedOrderForRetry(id, admin.id);
      }

      const fulfillment = await retryOrEnqueueFulfillment(id);
      const after = await prisma.order.findUnique({
        where: { id },
        select: { status: true, gelatoOrderId: true, gelatoSubmitStartedAt: true },
      });
      await logAdminAction({
        adminId: admin.id,
        action: "order.gelato_reconcile",
        targetType: "order",
        targetId: id,
        before: { status: order.status, gelatoOrderId: order.gelatoOrderId, gelatoSubmitStartedAt: iso(order.gelatoSubmitStartedAt) },
        after: {
          status: after?.status ?? null,
          gelatoOrderId: after?.gelatoOrderId ?? null,
          gelatoSubmitStartedAt: iso(after?.gelatoSubmitStartedAt),
          fulfillment,
        },
        note: gelatoOrderId ? "Order exists at Gelato: id recorded." : "Order doesn't exist at Gelato: marker cleared.",
      });
      return {
        order: {
          id,
          status: after?.status ?? order.status,
          gelatoOrderId: after?.gelatoOrderId ?? null,
          gelatoSubmitStartedAt: iso(after?.gelatoSubmitStartedAt),
        },
        fulfillment,
      };
    },
  );
}

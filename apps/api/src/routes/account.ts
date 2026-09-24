import type { FastifyInstance } from "fastify";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { prisma } from "../db";
import { requireCustomer } from "../auth/guard";
import { buildReceiptPdf } from "../print/receipt";
import { env } from "../env";
import { rateLimitPreHandler } from "../rateLimit";
import { SESSION_COOKIE, sessionCookieOptions } from "../auth/session";
import { customerDataStatus, deleteCustomerData } from "../gdpr/accountDeletion";

const OrderItemView = Type.Object({
  id: Type.String(),
  bookTitle: Type.String(),
  priceCents: Type.Number(),
});
const ErrorResponse = Type.Object({ message: Type.String() });

const MyDataItemView = Type.Object({
  id: Type.String(),
  sessionId: Type.String(),
  bookTitle: Type.String(),
  photos: Type.Union([Type.Literal("stored"), Type.Literal("deleted")]),
  bookFiles: Type.Union([Type.Literal("stored"), Type.Literal("deleted")]),
  pathway: Type.Union([Type.Literal("p1"), Type.Literal("p2"), Type.Literal("held")]),
  photosDeletionDueAt: Type.Union([Type.String(), Type.Null()]),
  bookFilesDeletionDueAt: Type.Union([Type.String(), Type.Null()]),
});
const MyDataView = Type.Object({
  orders: Type.Array(
    Type.Object({
      id: Type.String(),
      status: Type.String(),
      createdAt: Type.String(),
      deliveredAt: Type.Union([Type.String(), Type.Null()]),
      items: Type.Array(MyDataItemView),
    }),
  ),
});
// The exact word, so a stray or scripted DELETE can't wipe an account.
const DeleteMyDataBody = Type.Object({ confirm: Type.Literal("DELETE") });
const DeleteMyDataResponse = Type.Object({
  sessionsDeleted: Type.Number(),
  fileCount: Type.Number(),
  ordersAnonymised: Type.Number(),
  sessionsKeptShared: Type.Number(),
});
const BlockedResponse = Type.Object({
  message: Type.String(),
  orders: Type.Array(Type.Object({ id: Type.String(), status: Type.String() })),
});

const AccountOrderView = Type.Object({
  id: Type.String(),
  status: Type.String(),
  totalCents: Type.Number(),
  currency: Type.String(),
  createdAt: Type.String(),
  items: Type.Array(OrderItemView),
});

/**
 * The authenticated account area. Every route here enforces row-level security
 * the same way: resolve the customer from the session cookie, then scope the
 * query to `customerId = <that customer>`. A customer supplies only their
 * cookie, never an id, so they can only ever reach their own rows — an order id
 * that belongs to someone else simply isn't found for them.
 */
export async function registerAccountRoutes(app: FastifyInstance) {
  const api = app.withTypeProvider<TypeBoxTypeProvider>();

  // Order history — newest first, scoped to the logged-in customer.
  api.get(
    "/api/account/orders",
    { schema: { tags: ["account"], response: { 200: Type.Array(AccountOrderView) } } },
    async (request, reply) => {
      const customer = await requireCustomer(request, reply);
      if (!customer) return; // 401 already sent

      const orders = await prisma.order.findMany({
        where: { customerId: customer.id },
        include: { items: true },
        orderBy: { createdAt: "desc" },
      });
      return orders.map((o) => ({
        id: o.id,
        status: o.status,
        totalCents: o.totalCents,
        currency: o.currency,
        createdAt: o.createdAt.toISOString(),
        items: o.items.map((i) => ({ id: i.id, bookTitle: i.bookTitle, priceCents: i.priceCents })),
      }));
    },
  );

  // Receipt PDF download. RLS-gated: the `customerId` in the WHERE means another
  // customer's order id resolves to null here and returns 404, never their data.
  api.get(
    "/api/account/orders/:id/receipt",
    { schema: { tags: ["account"], params: Type.Object({ id: Type.String({ format: "uuid" }) }) } },
    async (request, reply) => {
      const customer = await requireCustomer(request, reply);
      if (!customer) return; // 401 already sent

      const order = await prisma.order.findFirst({
        where: { id: request.params.id, customerId: customer.id },
        include: { items: true },
      });
      if (!order) return reply.code(404).send({ message: "Order not found." });

      const pdf = await buildReceiptPdf({
        id: order.id,
        createdAt: order.createdAt,
        email: order.email,
        currency: order.currency,
        totalCents: order.totalCents,
        shippingName: order.shippingName,
        items: order.items.map((i) => ({ bookTitle: i.bookTitle, priceCents: i.priceCents })),
      });

      reply
        .header("Content-Type", "application/pdf")
        .header("Content-Disposition", `attachment; filename="receipt-${order.id}.pdf"`);
      return reply.send(pdf);
    },
  );

  // GDPR: what we hold per order and when it will be deleted (src/gdpr/schedule.ts).
  // Read by the /account "My Data" tab.
  api.get(
    "/api/account/my-data",
    { schema: { tags: ["account"], response: { 200: MyDataView, 401: ErrorResponse } } },
    async (request, reply) => {
      const customer = await requireCustomer(request, reply);
      if (!customer) return; // 401 already sent
      return { orders: await customerDataStatus(customer.id) };
    },
  );

  // GDPR Pathway 3: delete everything, now (src/gdpr/accountDeletion.ts).
  // Rate-limited in onRequest (not preHandler) so every attempt counts,
  // including ones rejected for a bad body or a missing login.
  api.delete(
    "/api/account/my-data",
    {
      onRequest: rateLimitPreHandler(app, { ipMax: env.RL_MY_DATA_IP_MAX, windowMinutes: env.RL_MY_DATA_WINDOW_MIN }),
      schema: {
        tags: ["account"],
        body: DeleteMyDataBody,
        response: {
          200: DeleteMyDataResponse,
          401: ErrorResponse,
          409: BlockedResponse,
          503: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const customer = await requireCustomer(request, reply);
      if (!customer) return; // 401 already sent

      const result = await deleteCustomerData(customer.id);
      switch (result.kind) {
        case "blocked":
          return reply.code(409).send({
            message:
              `Your data can't be deleted while an order is still being made. ` +
              `Try again once these orders have been dispatched: ` +
              result.orders.map((o) => `${o.id} (${o.status})`).join(", ") + ".",
            orders: result.orders,
          });
        case "payment_in_flight":
          return reply.code(409).send({
            message: `A payment for order(s) ${result.orderIds.join(", ")} is being processed. Please try again in a few minutes.`,
            orders: result.orderIds.map((id) => ({ id, status: "awaiting_payment" })),
          });
        case "stripe_unavailable":
          return reply.code(503).send({ message: "We couldn't complete the deletion right now. Nothing was deleted; please try again shortly." });
        case "deleted":
          // The customer row is gone, so the login cookie is meaningless: clear it.
          reply.clearCookie(SESSION_COOKIE, sessionCookieOptions(0));
          return {
            sessionsDeleted: result.sessionsDeleted,
            fileCount: result.fileCount,
            ordersAnonymised: result.ordersAnonymised,
            sessionsKeptShared: result.sessionsKeptShared,
          };
      }
    },
  );
}

import type { FastifyInstance } from "fastify";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { prisma } from "../db";

const ErrorResponse = Type.Object({ message: Type.String() });
const OrderParams = Type.Object({ id: Type.String({ format: "uuid" }) });

const OrderItemView = Type.Object({
  id: Type.String(),
  bookTitle: Type.String(),
  priceCents: Type.Number(),
});
const StatusEventView = Type.Object({
  status: Type.String(),
  source: Type.String(),
  createdAt: Type.String(),
});
// Public (no login): anyone holding the order id (the /track and /confirmation
// links) can read this, so it carries no personal data. No email, no address.
const OrderView = Type.Object({
  id: Type.String(),
  status: Type.String(),
  totalCents: Type.Number(),
  currency: Type.String(),
  createdAt: Type.String(),
  items: Type.Array(OrderItemView),
  statusEvents: Type.Array(StatusEventView),
});

export async function registerOrderRoutes(app: FastifyInstance) {
  const api = app.withTypeProvider<TypeBoxTypeProvider>();

  api.get(
    "/api/orders/:id",
    {
      schema: {
        tags: ["orders"],
        params: OrderParams,
        response: { 200: OrderView, 404: ErrorResponse },
      },
    },
    async (request, reply) => {
      const order = await prisma.order.findUnique({
        where: { id: request.params.id },
        include: { items: true, statusEvents: { orderBy: { createdAt: "asc" } } },
      });
      if (!order) {
        return reply.code(404).send({ message: "Order not found" });
      }
      return {
        id: order.id,
        status: order.status,
        totalCents: order.totalCents,
        currency: order.currency,
        createdAt: order.createdAt.toISOString(),
        items: order.items.map((i) => ({ id: i.id, bookTitle: i.bookTitle, priceCents: i.priceCents })),
        statusEvents: order.statusEvents.map((e) => ({
          status: e.status,
          source: e.source,
          createdAt: e.createdAt.toISOString(),
        })),
      };
    },
  );
}

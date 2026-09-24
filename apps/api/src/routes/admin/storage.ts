import type { FastifyInstance } from "fastify";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { prisma } from "../../db";
import { listObjects } from "../../storage";
import { SAFE_ID } from "../../gdpr/deleteSessionAssets";
import { deletionSchedule } from "../../gdpr/schedule";
import { categorize, getStorageSummary } from "../../admin/storage";
import { iso } from "./common";

/**
 * R2 usage. Deliberately metadata only: keys, sizes, dates. There is no way
 * to download or view a customer's photo through the admin API, and no
 * presigned URLs are created here.
 */
export async function registerAdminStorageRoutes(app: FastifyInstance) {
  const api = app.withTypeProvider<TypeBoxTypeProvider>();

  api.get(
    "/api/admin/storage/summary",
    { schema: { tags: ["admin"], querystring: Type.Object({ refresh: Type.Optional(Type.String({ maxLength: 5 })) }) } },
    async (request) => {
      const refresh = request.query.refresh === "1" || request.query.refresh === "true";
      return getStorageSummary({ refresh });
    },
  );

  api.get(
    "/api/admin/storage/sessions/:sessionId",
    {
      schema: {
        tags: ["admin"],
        // The id becomes an R2 prefix: same rule as deleteSessionAssets, so a
        // "/" or ".." can't widen the listing to another session's folder.
        params: Type.Object({ sessionId: Type.String({ pattern: SAFE_ID.source, maxLength: 128 }) }),
      },
    },
    async (request) => {
      const { sessionId } = request.params;
      const items = await prisma.orderItem.findMany({ where: { sessionId }, select: { id: true, orderId: true } });
      const itemPrefixes = items
        .filter((item) => SAFE_ID.test(item.id) && SAFE_ID.test(item.orderId))
        .map((item) => `orders/${item.orderId}/items/${item.id}/`);
      const listed = (await Promise.all([`sessions/${sessionId}/`, ...itemPrefixes].map(listObjects))).flat();
      const files = listed
        .sort((a, b) => a.key.localeCompare(b.key))
        .map((object) => ({
          key: object.key,
          size: object.size,
          lastModified: iso(object.lastModified),
          category: categorize(object.key),
        }));

      const session = await prisma.session.findUnique({
        where: { id: sessionId },
        select: { expiresAt: true, rawDeletedAt: true, processedDeletedAt: true },
      });
      const orderIds = [...new Set(items.map((item) => item.orderId))];
      const orders =
        orderIds.length === 0
          ? []
          : await prisma.order.findMany({
              where: { id: { in: orderIds } },
              select: { id: true, status: true, deliveredAt: true },
            });
      const schedule = session ? deletionSchedule(session, orders) : null;

      return {
        sessionId,
        files,
        session: session
          ? {
              expiresAt: iso(session.expiresAt),
              rawDeletedAt: iso(session.rawDeletedAt),
              processedDeletedAt: iso(session.processedDeletedAt),
            }
          : null,
        orders: orders.map((o) => ({ id: o.id, status: o.status })),
        schedule: schedule
          ? { pathway: schedule.pathway, rawDueAt: iso(schedule.rawDueAt), processedDueAt: iso(schedule.processedDueAt) }
          : null,
      };
    },
  );
}

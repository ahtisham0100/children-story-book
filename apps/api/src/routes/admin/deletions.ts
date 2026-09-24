import type { FastifyInstance } from "fastify";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../db";
import { env } from "../../env";
import { GDPR_SWEEP_JOB_OPTIONS, getGdprQueue } from "../../queue";
import { deleteSessionAssets, SAFE_ID } from "../../gdpr/deleteSessionAssets";
import { HOLDING_STATUSES } from "../../gdpr/schedule";
import { listScheduledDeletions } from "../../admin/scheduledDeletions";
import { logAdminAction } from "../../admin/audit";
import { currentAdmin } from "../../admin/plugin";
import { dateRange, INVALID_DATE, NO_REDIS, PageQuery, pageWindow } from "./common";

const SafeId = Type.String({ pattern: SAFE_ID.source, maxLength: 128 });

/**
 * Photo deletion: what's coming up, what happened, and the manual override.
 * The override goes through deleteSessionAssets like every other pathway
 * (trigger "admin", actor = the admin's customer id), so it gets the same
 * prefix guarantees and exactly one DeletionAuditLog row per call.
 */
export async function registerAdminDeletionRoutes(app: FastifyInstance) {
  const api = app.withTypeProvider<TypeBoxTypeProvider>();

  api.get(
    "/api/admin/deletions/scheduled",
    {
      schema: {
        tags: ["admin"],
        querystring: Type.Object({
          kind: Type.Union([Type.Literal("p1"), Type.Literal("p2_raw"), Type.Literal("p2_processed")]),
          withinDays: Type.Integer({ minimum: 0, maximum: 60, default: 7 }),
          cursor: Type.Optional(SafeId),
          limit: Type.Integer({ minimum: 1, maximum: 100, default: 50 }),
        }),
      },
    },
    async (request) => {
      const { kind, withinDays, cursor, limit } = request.query;
      return listScheduledDeletions({ kind, withinDays, cursor, limit });
    },
  );

  api.get(
    "/api/admin/deletions/audit",
    {
      schema: {
        tags: ["admin"],
        querystring: Type.Object({
          trigger: Type.Optional(Type.String({ maxLength: 40 })),
          outcome: Type.Optional(Type.Union([Type.Literal("succeeded"), Type.Literal("failed")])),
          sessionId: Type.Optional(SafeId),
          from: Type.Optional(Type.String({ maxLength: 40 })),
          to: Type.Optional(Type.String({ maxLength: 40 })),
          ...PageQuery,
        }),
      },
    },
    async (request, reply) => {
      const { trigger, outcome, sessionId, from, to, page, limit } = request.query;
      const createdAt = dateRange(from, to);
      if (createdAt === "invalid") return reply.code(400).send(INVALID_DATE);
      const where: Prisma.DeletionAuditLogWhereInput = {
        ...(trigger ? { trigger } : {}),
        ...(outcome ? { outcome } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(createdAt ? { createdAt } : {}),
      };
      const [total, rows] = await Promise.all([
        prisma.deletionAuditLog.count({ where }),
        prisma.deletionAuditLog.findMany({ where, orderBy: { createdAt: "desc" }, ...pageWindow(page, limit) }),
      ]);
      return {
        items: rows.map((r) => ({
          id: r.id,
          createdAt: r.createdAt.toISOString(),
          trigger: r.trigger,
          scope: r.scope,
          sessionId: r.sessionId,
          fileCount: r.fileCount,
          actor: r.actor,
          dryRun: r.dryRun,
          force: r.force,
          outcome: r.outcome,
          error: r.error,
        })),
        page,
        limit,
        total,
      };
    },
  );

  api.post(
    "/api/admin/deletions/sessions/:sessionId",
    {
      schema: {
        tags: ["admin"],
        params: Type.Object({ sessionId: SafeId }),
        body: Type.Object({
          scope: Type.Union([Type.Literal("raw"), Type.Literal("processed"), Type.Literal("all")]),
          // The exact word, like the customer's own deletion: a stray request can't delete.
          confirm: Type.Literal("DELETE"),
          dryRun: Type.Optional(Type.Boolean()),
          force: Type.Optional(Type.Boolean()),
        }),
      },
    },
    async (request, reply) => {
      const admin = currentAdmin(request);
      const { sessionId } = request.params;
      const { scope } = request.body;
      const dryRun = request.body.dryRun === true;
      const force = request.body.force === true;

      // Same "held" rule as the sweeper (schedule.ts HOLDING_STATUSES): the
      // book is being made, shipped, or may be re-rendered after a failure.
      const items = await prisma.orderItem.findMany({ where: { sessionId }, select: { orderId: true } });
      const orderIds = [...new Set(items.map((item) => item.orderId))];
      const holdingOrders =
        orderIds.length === 0
          ? []
          : (
              await prisma.order.findMany({
                where: { id: { in: orderIds }, status: { in: [...HOLDING_STATUSES] } },
                select: { id: true, status: true },
              })
            ).map((o) => ({ id: o.id, status: o.status }));

      // A dry run is always allowed (it's how the dashboard previews), and
      // reports the holding orders so the admin sees the warning up front.
      if (!dryRun && holdingOrders.length > 0 && !force) {
        return reply.code(409).send({
          message:
            `Session ${sessionId} belongs to ${holdingOrders.length} order(s) still in progress ` +
            `(${holdingOrders.map((o) => `${o.id}: ${o.status}`).join(", ")}). Deleting now would break those books. ` +
            `Send force: true to delete anyway; it will be recorded in the audit log.`,
          orders: holdingOrders,
        });
      }

      // Not automated, so GDPR_DELETION_DRY_RUN doesn't apply: an admin asked
      // for this explicitly (and the dashboard always dry-runs first).
      try {
        const result = await deleteSessionAssets(sessionId, { scope, trigger: "admin", actor: admin.id, dryRun, force });
        return { sessionId, scope, fileCount: result.fileCount, dryRun, force, holdingOrders };
      } catch (error) {
        // deleteSessionAssets has already written a failed audit row, and its
        // messages carry ids and counts only.
        return reply.code(502).send({
          message: `Deletion failed: ${error instanceof Error ? error.message : String(error)} Markers were left unset, so it can be retried.`,
        });
      }
    },
  );

  api.post(
    "/api/admin/deletions/sweep",
    {
      schema: {
        tags: ["admin"],
        body: Type.Object({ dryRun: Type.Optional(Type.Boolean()) }),
      },
    },
    async (request, reply) => {
      const admin = currentAdmin(request);
      if (!env.REDIS_URL) return reply.code(503).send(NO_REDIS);
      // Dry run unless explicitly asked otherwise, and GDPR_DELETION_DRY_RUN
      // forces one regardless (gdprWorker.ts / sweeper.ts).
      const dryRun = request.body.dryRun !== false;
      const effectiveDryRun = env.GDPR_DELETION_DRY_RUN || dryRun;
      const job = await getGdprQueue().add("sweep-manual", { dryRun }, GDPR_SWEEP_JOB_OPTIONS);
      await logAdminAction({
        adminId: admin.id,
        action: "gdpr.sweep",
        targetType: "queue",
        targetId: "gdpr",
        after: { jobId: job.id ?? null, dryRun, effectiveDryRun },
      });
      return { jobId: job.id ?? null, dryRun, effectiveDryRun };
    },
  );
}

import type { FastifyInstance } from "fastify";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { Job } from "bullmq";
import { prisma } from "../../db";
import { env } from "../../env";
import { adminQueueNames, getAdminQueue, JOB_STATES } from "../../admin/queues";
import { redact, summarize } from "../../admin/redact";
import { logAdminAction } from "../../admin/audit";
import { currentAdmin } from "../../admin/plugin";
import { hasUnknownGelatoOutcome, resetFailedOrderForRetry } from "../../admin/fulfillmentRetry";
import { NO_REDIS, PageQuery } from "./common";

const JobState = Type.Union(JOB_STATES.map((s) => Type.Literal(s)));
const QueueParams = Type.Object({ name: Type.String({ maxLength: 64 }) });
const JobParams = Type.Object({ name: Type.String({ maxLength: 64 }), id: Type.String({ minLength: 1, maxLength: 200 }) });

function jobListView(job: Job, state: string) {
  return {
    id: job.id ?? "",
    name: job.name,
    state,
    timestamp: job.timestamp ?? null,
    processedOn: job.processedOn ?? null,
    finishedOn: job.finishedOn ?? null,
    attemptsMade: job.attemptsMade ?? 0,
    maxAttempts: job.opts?.attempts ?? 1,
    dataSummary: summarize(job.data),
  };
}

function fulfillmentOrderId(queueName: string, job: Job): string | null {
  const orderId = (job.data as { orderId?: unknown } | undefined)?.orderId;
  return queueName === "fulfillment" && typeof orderId === "string" ? orderId : null;
}

async function unknownGelatoOutcome(orderId: string | null): Promise<boolean> {
  if (!orderId) return false;
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { gelatoSubmitStartedAt: true, gelatoOrderId: true },
  });
  return hasUnknownGelatoOutcome(order);
}

/**
 * Queue monitor + failed-job inspector. Queue names are whitelisted
 * (src/admin/queues.ts). Everything a job carries is passed through redact()
 * first: stage jobs hold signed photo URLs, and failure messages can echo
 * customer emails.
 */
export async function registerAdminQueueRoutes(app: FastifyInstance) {
  const api = app.withTypeProvider<TypeBoxTypeProvider>();

  api.get("/api/admin/queues", { schema: { tags: ["admin"] } }, async (_request, reply) => {
    if (!env.REDIS_URL) return reply.code(503).send(NO_REDIS);
    const queues = await Promise.all(
      adminQueueNames().map(async (name) => {
        const counts = await getAdminQueue(name)!.getJobCounts(...JOB_STATES);
        return {
          name,
          counts: Object.fromEntries(JOB_STATES.map((state) => [state, counts[state] ?? 0])),
        };
      }),
    );
    return { queues };
  });

  api.get(
    "/api/admin/queues/:name/jobs",
    {
      schema: {
        tags: ["admin"],
        params: QueueParams,
        querystring: Type.Object({ state: JobState, ...PageQuery }),
      },
    },
    async (request, reply) => {
      if (!env.REDIS_URL) return reply.code(503).send(NO_REDIS);
      const queue = getAdminQueue(request.params.name);
      if (!queue) return reply.code(404).send({ message: "Unknown queue." });
      const { state, page, limit } = request.query;
      const start = (page - 1) * limit;
      const [total, jobs] = await Promise.all([
        queue.getJobCountByTypes(state),
        queue.getJobs([state], start, start + limit - 1),
      ]);
      return {
        items: jobs.filter((job): job is Job => !!job).map((job) => jobListView(job, state)),
        page,
        limit,
        total,
      };
    },
  );

  api.get(
    "/api/admin/queues/:name/jobs/:id",
    { schema: { tags: ["admin"], params: JobParams } },
    async (request, reply) => {
      if (!env.REDIS_URL) return reply.code(503).send(NO_REDIS);
      const queue = getAdminQueue(request.params.name);
      if (!queue) return reply.code(404).send({ message: "Unknown queue." });
      const job = await queue.getJob(request.params.id);
      if (!job) return reply.code(404).send({ message: "Job not found (it may have been removed after completing)." });
      const state = await job.getState();
      return {
        ...jobListView(job, state),
        queue: request.params.name,
        data: redact(job.data ?? null),
        returnvalue: redact(job.returnvalue ?? null),
        failedReason: job.failedReason ? redact(job.failedReason) : null,
        stacktrace: redact(job.stacktrace ?? []),
        gelatoUnknownOutcome: await unknownGelatoOutcome(fulfillmentOrderId(request.params.name, job)),
      };
    },
  );

  api.post(
    "/api/admin/queues/:name/jobs/:id/retry",
    { schema: { tags: ["admin"], params: JobParams } },
    async (request, reply) => {
      const admin = currentAdmin(request);
      if (!env.REDIS_URL) return reply.code(503).send(NO_REDIS);
      const { name, id } = request.params;
      const queue = getAdminQueue(name);
      if (!queue) return reply.code(404).send({ message: "Unknown queue." });
      const job = await queue.getJob(id);
      if (!job) return reply.code(404).send({ message: "Job not found." });
      if (!(await job.isFailed())) return reply.code(409).send({ message: "Only failed jobs can be retried." });

      const orderId = fulfillmentOrderId(name, job);
      if (await unknownGelatoOutcome(orderId)) {
        return reply.code(409).send({
          code: "gelato_unknown_outcome",
          message:
            "This order's Gelato submission has an unknown outcome, so a retry would stop again. " +
            "Check Gelato's dashboard, then reconcile the order (record the Gelato order id, or clear the marker).",
          orderId,
        });
      }

      const orderReset = orderId ? await resetFailedOrderForRetry(orderId, admin.id) : false;
      const before = {
        state: "failed",
        attemptsMade: job.attemptsMade ?? 0,
        failedReason: job.failedReason ? redact(job.failedReason).slice(0, 300) : null,
      };
      await job.retry("failed", { resetAttemptsMade: true });
      await logAdminAction({
        adminId: admin.id,
        action: "job.retry",
        targetType: "job",
        targetId: `${name}:${id}`,
        before,
        after: { state: "waiting", orderReset },
      });
      return { ok: true, queue: name, jobId: id, orderReset };
    },
  );
}

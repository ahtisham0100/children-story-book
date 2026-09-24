import { Worker, type Job } from "bullmq";
import { createRedisConnection } from "./redis";
import { FULFILLMENT_ATTEMPTS, FULFILLMENT_QUEUE_NAME, type FulfillmentJobData } from "./queue";
import { isFinalAttempt, markFulfillmentFailed, runFulfillment } from "./fulfillment";

export async function processFulfillmentJob(job: Job<FulfillmentJobData>): Promise<void> {
  const { orderId } = job.data;
  const maxAttempts = job.opts.attempts ?? FULFILLMENT_ATTEMPTS;
  console.log(`[fulfillment] order ${orderId}: attempt ${job.attemptsMade + 1}/${maxAttempts} started`);
  try {
    await runFulfillment(orderId);
  } catch (error) {
    // Only the LAST failure marks the order failed. An earlier one is retried
    // with backoff, so /track doesn't flash "failed" over a transient blip.
    if (isFinalAttempt(error, job.attemptsMade, maxAttempts)) {
      await markFulfillmentFailed(orderId, error);
    }
    throw error;
  }
}

/**
 * Consumes the fulfillment queue. Started next to the pipeline worker in both
 * run modes (index.ts, worker-process.ts). Its own concurrency: a fulfilment
 * job mostly WAITS (on the pipeline render, R2, Gelato), so a few can run at
 * once without competing for CPU with the pipeline worker.
 */
export function startFulfillmentWorker(): Worker<FulfillmentJobData> {
  const worker = new Worker<FulfillmentJobData>(FULFILLMENT_QUEUE_NAME, processFulfillmentJob, {
    connection: createRedisConnection(),
    concurrency: Number(process.env.FULFILLMENT_CONCURRENCY ?? "2"),
  });

  worker.on("failed", (job, error) => {
    const attempts = job ? `${job.attemptsMade}/${job.opts.attempts ?? FULFILLMENT_ATTEMPTS}` : "-";
    console.error(`[fulfillment] job ${job?.id ?? "-"} (attempt ${attempts}) FAILED:`, error.message);
  });
  worker.on("stalled", (jobId) => {
    console.error(`[fulfillment] job ${jobId} STALLED — BullMQ is reprocessing it (steps are idempotent, so this is safe).`);
  });
  worker.on("error", (error) => {
    console.error("[fulfillment] worker-level error:", error.message);
  });

  return worker;
}

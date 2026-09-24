import { Queue, QueueEvents } from "bullmq";
import { createQueueRedisConnection, createRedisConnection } from "./redis";

export const PIPELINE_QUEUE_NAME = "pipeline";

// "preview" renders only the pages flagged for the free preview; "full" renders
// the whole book (run after purchase). Splitting these is the main cost control:
// most visitors preview and never buy.
export type PipelineMode = "preview" | "full";

export interface PipelineJobData {
  sessionId: string;
  mode: PipelineMode;
}

let queueSingleton: Queue<PipelineJobData> | undefined;

export function getPipelineQueue(): Queue<PipelineJobData> {
  queueSingleton ??= new Queue<PipelineJobData>(PIPELINE_QUEUE_NAME, {
    connection: createQueueRedisConnection(),
  });
  return queueSingleton;
}

let queueEventsSingleton: QueueEvents | undefined;

export function getPipelineQueueEvents(): QueueEvents {
  queueEventsSingleton ??= new QueueEvents(PIPELINE_QUEUE_NAME, {
    connection: createRedisConnection(),
  });
  return queueEventsSingleton;
}

// --- Fulfilment ---------------------------------------------------------
// One job per paid order (render → PDF → Gelato → emails, see fulfillment.ts).
// It lives in Redis rather than as an in-process promise, so a crash mid-way
// doesn't silently lose a paid order, and failed jobs stay inspectable and
// retryable later.

export const FULFILLMENT_QUEUE_NAME = "fulfillment";

export interface FulfillmentJobData {
  orderId: string;
}

// Every step in fulfillment.ts is idempotent, so retrying is safe. With a 30s
// exponential backoff the 5 attempts span ~7.5 minutes (30s, 1m, 2m, 4m).
// removeOnFail:false keeps failed jobs, with their error and stack, for
// inspection. Completed jobs are kept for a week so a late duplicate Stripe
// webhook is deduped against them by jobId instead of re-running fulfilment.
export const FULFILLMENT_ATTEMPTS = 5;
const FULFILLMENT_JOB_OPTIONS = {
  attempts: FULFILLMENT_ATTEMPTS,
  backoff: { type: "exponential", delay: 30_000 },
  removeOnComplete: { age: 7 * 24 * 3600 },
  removeOnFail: false,
} as const;

let fulfillmentQueueSingleton: Queue<FulfillmentJobData> | undefined;

export function getFulfillmentQueue(): Queue<FulfillmentJobData> {
  fulfillmentQueueSingleton ??= new Queue<FulfillmentJobData>(FULFILLMENT_QUEUE_NAME, {
    connection: createQueueRedisConnection(),
  });
  return fulfillmentQueueSingleton;
}

/**
 * jobId = orderId is the dedup: Stripe's at-least-once webhook delivery can
 * enqueue the same order several times, and BullMQ ignores an add() for an id
 * it still holds (waiting, active, completed-within-a-week, or failed).
 */
export async function enqueueFulfillment(orderId: string) {
  return getFulfillmentQueue().add("fulfill", { orderId }, { ...FULFILLMENT_JOB_OPTIONS, jobId: orderId });
}

// --- GDPR deletion sweep --------------------------------------------------
// One repeatable job (a BullMQ job scheduler) runs src/gdpr/sweeper.ts every
// GDPR_SWEEP_INTERVAL_MINUTES. See src/gdprWorker.ts.

export const GDPR_QUEUE_NAME = "gdpr";
export const GDPR_SWEEP_SCHEDULER_ID = "gdpr-sweep";

// attempts:1 because the next scheduled run IS the retry (a failed session's
// markers stay unset, so it's picked up again). removeOnFail:false keeps a
// failed sweep, with its error naming the failed session ids, for the future
// admin dashboard. Completed sweeps are kept a week for the same reason.
export const GDPR_SWEEP_JOB_OPTIONS = {
  attempts: 1,
  removeOnComplete: { age: 7 * 24 * 3600 },
  removeOnFail: false,
} as const;

let gdprQueueSingleton: Queue | undefined;

export function getGdprQueue(): Queue {
  gdprQueueSingleton ??= new Queue(GDPR_QUEUE_NAME, { connection: createQueueRedisConnection() });
  return gdprQueueSingleton;
}

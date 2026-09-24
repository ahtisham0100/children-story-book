import type { Queue } from "bullmq";
import { env } from "../env";
import { getFulfillmentQueue, getGdprQueue, getPipelineQueue } from "../queue";
import { getStageQueue } from "../pipeline/queueStageRunner";
import { STAGE_NAMES, stageQueueName } from "../pipeline/stageQueue";

/**
 * The queues the admin monitor may touch, by name. A request's `:name` is only
 * ever used as a key into this list; it never reaches `new Queue()`, so a
 * forged request can't make the API open arbitrary Redis keys. Stage queues
 * exist only when stages run through BullMQ (STAGE_EXECUTION=queued).
 */
export const JOB_STATES = ["active", "waiting", "delayed", "completed", "failed"] as const;
export type AdminJobState = (typeof JOB_STATES)[number];

type QueueGetter = () => Queue;

function registry(): [string, QueueGetter][] {
  const core: [string, QueueGetter][] = [
    ["pipeline", getPipelineQueue as unknown as QueueGetter],
    ["fulfillment", getFulfillmentQueue as unknown as QueueGetter],
    ["gdpr", getGdprQueue],
  ];
  if (env.STAGE_EXECUTION !== "queued") return core;
  const stages = STAGE_NAMES.map((stage): [string, QueueGetter] => [
    stageQueueName(stage),
    () => getStageQueue(stage) as unknown as Queue,
  ]);
  return [...core, ...stages];
}

export function adminQueueNames(): string[] {
  return registry().map(([name]) => name);
}

/** The whitelisted queue, or undefined for any other name. */
export function getAdminQueue(name: string): Queue | undefined {
  return registry().find(([known]) => known === name)?.[1]();
}

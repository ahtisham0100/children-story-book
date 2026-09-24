import { Worker, type Job } from "bullmq";
import { env } from "./env";
import { createRedisConnection } from "./redis";
import { GDPR_QUEUE_NAME, GDPR_SWEEP_JOB_OPTIONS, GDPR_SWEEP_SCHEDULER_ID, getGdprQueue } from "./queue";
import { runGdprSweep, totalFailed, type SweepResult } from "./gdpr/sweeper";

/**
 * One scheduled sweep. Every due session is attempted even if some fail; only
 * then does the job fail, so BullMQ keeps it (removeOnFail:false) with an
 * error naming the failed sessions. The returned summary is stored as the
 * job's return value for the future admin dashboard.
 */
export async function processGdprJob(job: Job): Promise<SweepResult> {
  console.log(`[gdpr] sweep job ${job.id ?? "-"} started${env.GDPR_DELETION_DRY_RUN ? " (DRY RUN)" : ""}`);
  const result = await runGdprSweep();
  const failed = totalFailed(result);
  if (failed > 0) {
    const ids = [...result.p1.failedSessionIds, ...result.p2Raw.failedSessionIds, ...result.p2Processed.failedSessionIds];
    throw new Error(`GDPR sweep: ${failed} session deletion(s) failed (will retry next run): ${ids.join(", ")}`);
  }
  return result;
}

/**
 * Consumes the gdpr queue and (re)registers the repeatable sweep. Started next
 * to the pipeline and fulfilment workers in both run modes (index.ts,
 * worker-process.ts). upsertJobScheduler is idempotent: restarting the
 * process, or changing GDPR_SWEEP_INTERVAL_MINUTES, updates the one schedule
 * rather than adding a second. Concurrency 1: two sweeps never overlap.
 */
export function startGdprWorker(): Worker {
  const worker = new Worker(GDPR_QUEUE_NAME, processGdprJob, {
    connection: createRedisConnection(),
    concurrency: 1,
  });

  const everyMs = Math.max(1, env.GDPR_SWEEP_INTERVAL_MINUTES) * 60_000;
  getGdprQueue()
    .upsertJobScheduler(GDPR_SWEEP_SCHEDULER_ID, { every: everyMs }, { name: "sweep", opts: GDPR_SWEEP_JOB_OPTIONS })
    .then(() =>
      console.log(
        `[gdpr] sweep scheduled every ${env.GDPR_SWEEP_INTERVAL_MINUTES} min${env.GDPR_DELETION_DRY_RUN ? " — DRY RUN (GDPR_DELETION_DRY_RUN is not \"false\"), nothing will be deleted" : ""}.`,
      ),
    )
    .catch((error: Error) => console.error("[gdpr] failed to schedule the sweep:", error.message));

  worker.on("failed", (job, error) => {
    console.error(`[gdpr] sweep job ${job?.id ?? "-"} FAILED:`, error.message);
  });
  worker.on("error", (error) => {
    console.error("[gdpr] worker-level error:", error.message);
  });

  return worker;
}

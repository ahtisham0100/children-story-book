import { randomUUID } from "node:crypto";
import { Worker, type Job } from "bullmq";
import { createRedisConnection } from "./redis";
import { getObjectBuffer, putObject } from "./storage";
import {
  STAGE_NAMES,
  stageQueueName,
  heartbeatKey,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TTL_SECONDS,
  type StageJobData,
  type StageJobResult,
  type StageName,
} from "./pipeline/stageQueue";
import { repaintScene } from "./pipeline/stages/repaint";
import { swapIdentity } from "./pipeline/stages/swap";
import { restoreFace } from "./pipeline/stages/restore";
import { healSwapArtifacts } from "./pipeline/stages/heal";
import { restoreEyeRegion } from "./pipeline/stages/eyes";
import { warmFaceDetector } from "./pipeline/faceDetect";

// CONSUMER side of the per-stage queue split (see queueStageRunner.ts for the
// producer side and the full design rationale). One process, dedicated to
// exactly ONE stage, selected by the STAGE env var. Run as many instances as
// you want, per stage — e.g. more `swap`/`restore` workers if Replicate
// latency is the bottleneck, more `heal`/`eyes` workers if local CPU is.
//
// THE WARM-UP POINT: because an instance only ever processes one stage, it
// never cold-starts switching between kinds of work. heal/eyes both call
// detectFaces (faceDetect.ts), which lazily loads a TF.js blazeface model on
// first use and keeps it resident for the life of the process — warmed here
// explicitly at boot (mirrors worker.ts's own warm-up) so the very first job
// this instance ever picks up doesn't pay that cost. A repaint/swap/restore
// instance never touches that model at all. Only enabled end-to-end when
// env.STAGE_EXECUTION === "queued" in worker.ts — with the default ("direct")
// these processes have nothing to consume, and running them is harmless but
// pointless.

const stageArg = process.env.STAGE;
if (!stageArg || !STAGE_NAMES.includes(stageArg as StageName)) {
  console.error(`[stage-worker] Set STAGE to one of: ${STAGE_NAMES.join(", ")}. Got: ${stageArg ?? "(unset)"}`);
  process.exit(1);
}
// Narrowed and validated above; TS control-flow narrowing doesn't carry a
// module-scope const into functions declared later in the file, so re-bind.
const STAGE = stageArg as StageName;

if (STAGE === "heal" || STAGE === "eyes") {
  void warmFaceDetector();
}

// Liveness heartbeat — see stageQueue.ts's heartbeatKey comment for why this
// exists instead of relying on BullMQ's Queue#getWorkers(). A plain
// SET+EXPIRE, refreshed on an interval; the orchestrator just checks whether
// the key currently exists. Started immediately (not gated on the Worker
// being fully ready) since the failure mode this guards against is "nothing
// is listening at all," not "listening but not yet warm."
const heartbeatRedis = createRedisConnection();
async function beat(): Promise<void> {
  try {
    await heartbeatRedis.set(heartbeatKey(STAGE), new Date().toISOString(), "EX", HEARTBEAT_TTL_SECONDS);
  } catch (error) {
    console.error(`[stage-worker:${STAGE}] heartbeat write failed:`, (error as Error).message);
  }
}
void beat();
const heartbeatTimer = setInterval(() => void beat(), HEARTBEAT_INTERVAL_MS);

async function runStageWork(stage: StageName, data: StageJobData): Promise<Buffer> {
  const input = await getObjectBuffer(data.inputKey);
  switch (stage) {
    case "repaint":
      if (!data.photoUrl) throw new Error("repaint stage job missing photoUrl");
      return repaintScene(input, data.photoUrl, data.repaintModel);
    case "swap":
      if (!data.photoUrl) throw new Error("swap stage job missing photoUrl");
      return swapIdentity(input, data.photoUrl);
    case "restore":
      return restoreFace(input);
    case "heal":
      return healSwapArtifacts(input);
    case "eyes": {
      if (!data.repaintedKey) throw new Error("eyes stage job missing repaintedKey");
      const repainted = await getObjectBuffer(data.repaintedKey);
      return restoreEyeRegion(input, repainted);
    }
  }
}

async function processStageJob(job: Job<StageJobData>): Promise<StageJobResult> {
  const started = Date.now();
  console.log(`[stage-worker:${STAGE}] job ${job.id ?? "-"} received, starting work`);
  const output = await runStageWork(STAGE, job.data);
  const workDoneAt = Date.now();
  const outputKey = `scratch/${STAGE}-out/${randomUUID()}.png`;
  await putObject(outputKey, output, "image/png");
  console.log(
    `[stage-worker:${STAGE}] job ${job.id ?? "-"} done — work ${workDoneAt - started}ms, ` +
      `output upload ${Date.now() - workDoneAt}ms, total ${Date.now() - started}ms`,
  );
  return { outputKey };
}

const worker = new Worker<StageJobData, StageJobResult>(stageQueueName(STAGE), processStageJob, {
  connection: createRedisConnection(),
  concurrency: Number(process.env.STAGE_CONCURRENCY ?? "3"),
});
console.log(`[stage-worker:${STAGE}] listening on "${stageQueueName(STAGE)}", concurrency ${String(worker.opts.concurrency)}`);

// Catch-all, distinct from processStageJob's own try/catch: this fires for
// ANY job failure BullMQ records, including ones that never reached (or threw
// before) our own logging inside processStageJob/runStageWork — nothing about
// a failed job goes unlogged.
worker.on("failed", (job, error) => {
  console.error(`[stage-worker:${STAGE}] job ${job?.id ?? "-"} FAILED:`, error.message);
});
// See worker.ts's identical listener for why this matters: an unmonitored
// stall means BullMQ silently reprocessed a job from scratch, invisible from
// outside except as unexplained extra latency and (for a hosted stage) a
// second paid API call.
worker.on("stalled", (jobId) => {
  console.error(`[stage-worker:${STAGE}] job ${jobId} STALLED — BullMQ is reprocessing it. Check for a blocked event loop or a Redis blip.`);
});
worker.on("error", (error) => {
  console.error(`[stage-worker:${STAGE}] worker-level error:`, error.message);
});

async function shutdown() {
  clearInterval(heartbeatTimer);
  await worker.close();
  await heartbeatRedis.quit();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

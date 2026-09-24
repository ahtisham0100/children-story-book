import { randomUUID } from "node:crypto";
import { Queue, QueueEvents } from "bullmq";
import { createRedisConnection, createQueueRedisConnection } from "../redis";
import { getObjectBuffer, putObject } from "../storage";
import { STAGE_NAMES, stageQueueName, type StageJobData, type StageJobResult, type StageName } from "./stageQueue";
import type { StageRunner } from "./personalize";

// PRODUCER side of the per-stage queue split. Each of the 5 stages gets its
// own BullMQ queue; this module enqueues one job per stage call and awaits
// THAT job's own completion (BullMQ's QueueEvents + Job#waitUntilFinished),
// rather than doing any stage work itself. The consumer side is
// src/stage-worker.ts — one process, dedicated to one stage, run as many
// times as you want per stage.
//
// Only used when env.STAGE_EXECUTION === "queued" (worker.ts). The CLI and
// homepage_local never import this file — they use the default direct
// in-process StageRunner in personalize.ts, which needs no queue infra at all.
//
// WHY R2 FOR THE HANDOFF, NOT THE JOB PAYLOAD: images are hundreds of KB to a
// few MB. BullMQ job data round-trips through Redis as JSON; embedding image
// bytes there would bloat every job and put real pressure on a metered Redis
// plan (Upstash). R2 is already the project's shared, durable blob store
// (storage.ts), so each stage reads its input from an R2 key and writes its
// output to a new one — the job payload itself only ever carries small
// strings (keys, URLs).
//
// CLEANUP: this creates scratch objects under `scratch/` that are never
// explicitly deleted — deleting them precisely (only after the LAST stage
// that needs them, across every character crop on a page) is easy to get
// wrong in a way that deletes something still in flight. Set an R2 lifecycle
// rule expiring the `scratch/` prefix after ~1 day (Cloudflare dashboard, not
// code) instead of adding that logic here — same pattern as the CORS policy
// noted in docs/INFRA_AND_PIPELINE_TRACE.md.

// Generous: a stage may need a cold start (Replicate) plus its own no-face
// retries (up to 4, each potentially a full paid round trip) before it
// resolves. A tighter timeout would fail a job that was still genuinely
// working.
const STAGE_JOB_TIMEOUT_MS = 10 * 60_000;

const queues = new Map<StageName, Queue<StageJobData, StageJobResult>>();
function getQueue(stage: StageName): Queue<StageJobData, StageJobResult> {
  let q = queues.get(stage);
  if (!q) {
    q = new Queue(stageQueueName(stage), { connection: createQueueRedisConnection() });
    queues.set(stage, q);
  }
  return q;
}

// One shared QueueEvents connection per stage, not one per waitUntilFinished
// call — same reasoning as status-events.ts's shared subscriber: a fresh
// connection per call would multiply with concurrent renders and risk the
// same Upstash connection-limit problem that bit the old SSE design.
const queueEventsByStage = new Map<StageName, QueueEvents>();
function getQueueEvents(stage: StageName): QueueEvents {
  let e = queueEventsByStage.get(stage);
  if (!e) {
    e = new QueueEvents(stageQueueName(stage), { connection: createRedisConnection() });
    queueEventsByStage.set(stage, e);
  }
  return e;
}

function scratchKey(label: string): string {
  return `scratch/${label}/${randomUUID()}.png`;
}

// A buffer returned by one runStage call is already sitting in R2 under a
// known key (we just downloaded it from there to hand back). personalizeBuffer's
// stage chain always passes that exact object straight into the next stage
// call (`result = await stageRunner.swap(result, ...)`), so re-uploading it
// under a fresh scratch key is wasted round-trip work: same bytes, new key,
// immediately re-downloaded by the next stage-worker. Keyed on object
// identity (WeakMap), not content — safe across concurrent renders since
// every Buffer instance is distinct regardless of what's in it, and entries
// fall out once a buffer is garbage collected. Cuts what was 4 R2 ops per
// stage boundary (orchestrator upload, stage-worker download, stage-worker
// upload, orchestrator download) down to 3 for every stage after the first.
const knownR2Keys = new WeakMap<Buffer, string>();

async function ensureUploaded(buf: Buffer, label: string): Promise<{ key: string; uploadMs: number }> {
  const known = knownR2Keys.get(buf);
  if (known) return { key: known, uploadMs: 0 };
  const started = Date.now();
  const key = scratchKey(label);
  await putObject(key, buf, "image/png");
  return { key, uploadMs: Date.now() - started };
}

async function runStage(stage: StageName, inputBuf: Buffer, extra: Omit<StageJobData, "inputKey"> = {}): Promise<Buffer> {
  const started = Date.now();
  const { key: inputKey, uploadMs } = await ensureUploaded(inputBuf, stage);

  const job = await getQueue(stage).add(
    stage,
    { inputKey, ...extra } as StageJobData,
    // NOT removeOnComplete: true — that deletes the job record the INSTANT it
    // completes. job.waitUntilFinished() below has a fallback DB check
    // specifically for "the job finished before my event listener attached,"
    // but that fallback only works if the job record still exists to check.
    // Confirmed live: a fast stage job (heal/eyes can finish in ~10s) that
    // completes before this orchestrator gets around to calling
    // waitUntilFinished (busy juggling other concurrent pages) — completed
    // AND removed — leaves nothing for either the event listener (already
    // missed) or the DB fallback (already gone) to find. That call then hangs
    // forever waiting for a completion that already happened. Keeping a
    // bounded window of completed jobs closes that race; still bounded so
    // Redis doesn't grow unboundedly over a long-running deployment.
    { attempts: 1, removeOnComplete: { count: 1000, age: 3600 }, removeOnFail: 100 },
  );
  const enqueuedAt = Date.now();
  console.log(
    `[queueStageRunner] stage "${stage}" job ${job.id ?? "-"} enqueued (input upload took ` +
      `${uploadMs === 0 ? "0ms — reused prior stage's R2 key" : `${uploadMs}ms`})`,
  );
  try {
    const result = await job.waitUntilFinished(getQueueEvents(stage), STAGE_JOB_TIMEOUT_MS);
    const finishedAt = Date.now();
    console.log(
      `[queueStageRunner] stage "${stage}" job ${job.id ?? "-"} completed — queue+execute took ${finishedAt - enqueuedAt}ms ` +
        `(total incl. upload: ${finishedAt - started}ms)`,
    );
    const output = await getObjectBuffer(result.outputKey);
    knownR2Keys.set(output, result.outputKey);
    return output;
  } catch (error) {
    console.error(
      `[queueStageRunner] stage "${stage}" job ${job.id ?? "-"} FAILED after ${Date.now() - enqueuedAt}ms:`,
      (error as Error).message,
    );
    throw error;
  }
}

export const queueStageRunner: StageRunner = {
  repaint: (templateBuf, photoUri, model) => runStage("repaint", templateBuf, { photoUrl: photoUri, repaintModel: model }),
  swap: (targetBuf, photoUri) => runStage("swap", targetBuf, { photoUrl: photoUri }),
  restore: (imageBuf) => runStage("restore", imageBuf),
  heal: (imageBuf) => runStage("heal", imageBuf),
  eyes: async (swappedBuf, repaintBuf) => {
    // The eyes stage needs a SECOND image (the pre-swap repaint). repaintBuf is
    // the exact object the repaint stage returned earlier, so it's almost
    // always already sitting in R2 under repaint's own output key —
    // ensureUploaded reuses that key instead of uploading a duplicate copy.
    const { key: repaintedKey } = await ensureUploaded(repaintBuf, "eyes-repainted");
    return runStage("eyes", swappedBuf, { repaintedKey });
  },
};

// Exported for stage-worker.ts's startup log only (confirms the two files
// agree on the set of valid stage names).
export { STAGE_NAMES };

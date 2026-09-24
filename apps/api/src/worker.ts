import { Worker, type Job } from "bullmq";
import { createRedisConnection } from "./redis";
import { PIPELINE_QUEUE_NAME, type PipelineJobData } from "./queue";
import { prisma } from "./db";
import { env } from "./env";
import { publishStatus } from "./status-events";
import { STEP_MESSAGES, STAGE_MESSAGES } from "./messages";
import type { CharacterInput, PipelineStep } from "./pipeline/types";
import { validatePhoto } from "./pipeline/validate";
import { personalizePage, type PersonalizeOptions } from "./pipeline/personalize";
import { queueStageRunner } from "./pipeline/queueStageRunner";
import { STAGE_NAMES, heartbeatKey } from "./pipeline/stageQueue";
import { getBook, pagesFor, pageObjectKey, type Page } from "./pipeline/catalog";
import { mapWithConcurrency } from "./pipeline/pool";
import { createDownloadUrl, putObject, objectExists } from "./storage";
import { warmFaceDetector } from "./pipeline/faceDetect";

// STAGE_EXECUTION=queued routes each of the 5 stages through its own BullMQ
// queue (see pipeline/queueStageRunner.ts + stage-worker.ts) instead of
// calling them in-process. Computed once, not per-page: same choice for every
// render this process handles.
const stageRunnerOpts: Pick<PersonalizeOptions, "stageRunner"> =
  env.STAGE_EXECUTION === "queued" ? { stageRunner: queueStageRunner } : {};

// How many pages are personalized at once. Each page may itself issue one
// repaint+swap per character, so the real ceiling on in-flight API calls is this
// times the number of children.
const PAGE_CONCURRENCY = Number(process.env.PAGE_CONCURRENCY ?? "3");

// Replicate fetches the child's photo itself, so it gets a signed link rather
// than the bytes. Long-lived enough to cover a whole book's pages.
const PHOTO_URL_TTL_SECONDS = 3600;

async function runStep<T>(
  sessionId: string,
  step: PipelineStep,
  slot: string | undefined,
  action: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  console.log(`[worker] session ${sessionId}: step "${step}" (slot: ${slot ?? "-"}) started`);
  await publishStatus(sessionId, { type: "status", step, slot, message: STEP_MESSAGES[step] });
  try {
    const result = await action();
    console.log(`[worker] session ${sessionId}: step "${step}" (slot: ${slot ?? "-"}) finished in ${Date.now() - started}ms`);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Something went wrong.";
    // A generic message like "fetch failed" hides the actual cause (ECONNRESET,
    // ETIMEDOUT, DNS failure, etc.) — log the full error so a failure can be
    // diagnosed from server logs alone, without needing to reproduce it.
    console.error(
      `[worker] session ${sessionId}: step "${step}" (slot: ${slot ?? "-"}) FAILED after ${Date.now() - started}ms:`,
      error,
    );
    await publishStatus(sessionId, { type: "error", step, slot, message });
    await prisma.session.update({ where: { id: sessionId }, data: { status: "failed" } });
    throw error;
  }
}

async function processJob(job: Job<PipelineJobData>): Promise<void> {
  const { sessionId, mode } = job.data;
  const jobStarted = Date.now();
  // The gap between "job enqueued" (upload-confirm's timestamp, in Postgres/
  // logs elsewhere) and this line is genuine BullMQ queue wait — logged
  // explicitly so a "stuck on queued" report can be pinned to either that gap
  // or to work that happens after this line, instead of guessing.
  console.log(`[worker] session ${sessionId}: job picked up (mode: ${mode}, bullmq job id: ${job.id ?? "-"})`);

  const session = await prisma.session.update({
    where: { id: sessionId },
    data: { status: "processing" },
  });
  const book = getBook(session.storyId);
  const pages = pagesFor(book, mode);

  const characterRows = await prisma.character.findMany({ where: { sessionId }, orderBy: { slot: "asc" } });
  if (characterRows.length === 0) {
    throw new Error(`Session ${sessionId} has no characters.`);
  }

  // Per-child prep. Photos are independent, so validate them together.
  const characters: CharacterInput[] = await Promise.all(
    characterRows.map(async (character) => {
      if (!character.rawKey) {
        throw new Error(`Character ${character.id} (${character.slot}) has no uploaded photo.`);
      }
      const rawKey = character.rawKey;

      // Local face detection — no API cost — and it confirms the photo is usable
      // before we spend anything on rendering.
      await runStep(sessionId, "validate", character.slot, () => validatePhoto(rawKey));

      return {
        slot: character.slot,
        photoUrl: await createDownloadUrl(rawKey, PHOTO_URL_TTL_SECONDS),
      } satisfies CharacterInput;
    }),
  );

  await runStep(sessionId, "render", undefined, () =>
    mapWithConcurrency(pages, PAGE_CONCURRENCY, async (page: Page) => {
      const key = pageObjectKey(sessionId, page.id);
      // Never pay twice for the same page: a retried job, or a "full" run after
      // a preview, reuses whatever is already rendered.
      if (await objectExists(key)) {
        console.log(`[worker] session ${sessionId}: page "${page.id}" already exists in R2 — skipping.`);
        return;
      }
      const pageStarted = Date.now();
      console.log(`[worker] session ${sessionId}: page "${page.id}" render starting`);
      await publishStatus(sessionId, { type: "status", step: "render", page: page.id, message: "Starting…" });
      let stageStarted = Date.now();
      const finished = await personalizePage(page, characters, {
        ...stageRunnerOpts,
        onStage: (stage) => {
          const now = Date.now();
          console.log(
            `[worker] session ${sessionId}: page "${page.id}" stage "${stage}" finished in ${now - stageStarted}ms ` +
              `(page elapsed so far: ${now - pageStarted}ms)`,
          );
          stageStarted = now;
          return publishStatus(sessionId, { type: "status", step: "render", page: page.id, stage, message: STAGE_MESSAGES[stage] });
        },
      });
      await putObject(key, finished, "image/png");
      console.log(`[worker] session ${sessionId}: page "${page.id}" render TOTAL ${Date.now() - pageStarted}ms`);
    }),
  );

  const firstPage = pages[0];
  if (!firstPage) {
    throw new Error(`Book "${session.storyId}" has no pages to render for mode "${mode}".`);
  }
  const previewKey = pageObjectKey(sessionId, firstPage.id);
  await prisma.session.update({
    where: { id: sessionId },
    data: { status: "done", previewKey },
  });

  console.log(`[worker] session ${sessionId}: job DONE, total ${Date.now() - jobStarted}ms`);
  const previewUrl = await createDownloadUrl(previewKey, PHOTO_URL_TTL_SECONDS);
  await publishStatus(sessionId, { type: "done", previewUrl });
}

// STAGE_EXECUTION=queued means a render silently HANGS (not fails) if a stage
// job is enqueued and nothing is listening on that stage's queue — there's no
// error to see, just a job that never completes. Rather than leave that to be
// discovered by a stuck render, check for a live consumer on every stage queue
// at boot and log the result loudly, per stage.
//
// Deliberately NOT BullMQ's Queue#getWorkers() — verified live against this
// project's Upstash instance that it's unreliable: a stage-worker confirmed
// listening (via its own boot log) was reported as "0 workers" by
// getWorkers(), and WHICH stage came back missing changed across repeated
// checks a few seconds apart with nothing else changing — a CLIENT LIST
// visibility gap in that Redis backend, not a real connectivity problem.
// Checked instead via a plain heartbeat key each stage-worker refreshes
// itself (stageQueue.ts's heartbeatKey) — only depends on GET, not on Redis
// faithfully exposing cross-connection introspection.
//
// Retries with a grace period before declaring a stage unmonitored: on a
// normal concurrent boot (this process and all 5 stage-worker processes
// starting together), the orchestrator can easily reach this check before a
// stage-worker has written its first heartbeat.
const CONNECTIVITY_CHECK_ATTEMPTS = 10;
const CONNECTIVITY_CHECK_INTERVAL_MS = 1000;

async function verifyStageWorkersConnected(): Promise<void> {
  const redis = createRedisConnection();
  try {
    for (const stage of STAGE_NAMES) {
      let lastSeen: string | null = null;
      for (let attempt = 0; attempt < CONNECTIVITY_CHECK_ATTEMPTS; attempt += 1) {
        lastSeen = await redis.get(heartbeatKey(stage));
        if (lastSeen) break;
        await new Promise((r) => setTimeout(r, CONNECTIVITY_CHECK_INTERVAL_MS));
      }
      if (!lastSeen) {
        console.error(
          `[worker] ⚠ stage "${stage}": NO heartbeat after ${CONNECTIVITY_CHECK_ATTEMPTS}s. A render needing ` +
            `this stage will hang until a worker starts — run \`npm run stage:${stage}\`.`,
        );
      } else {
        console.log(`[worker] stage "${stage}": alive, last heartbeat ${lastSeen}.`);
      }
    }
  } finally {
    await redis.quit();
  }
}

export function startPipelineWorker(): Worker<PipelineJobData> {
  // Fire-and-forget: loads the blazeface model now so the first real job
  // doesn't pay the ~5-13s one-time load cost. Safe to not await — any job
  // that starts before this resolves just shares the same in-flight promise
  // (see getModel in faceDetect.ts), it never loads twice.
  void warmFaceDetector();

  console.log(`[worker] STAGE_EXECUTION=${env.STAGE_EXECUTION}${env.STAGE_EXECUTION === "queued" ? " — all 5 stages route through BullMQ, none run in-process" : " — stages run in-process (direct)"}`);
  if (env.STAGE_EXECUTION === "queued") {
    void verifyStageWorkersConnected();
  }

  const worker = new Worker<PipelineJobData>(PIPELINE_QUEUE_NAME, processJob, {
    connection: createRedisConnection(),
    concurrency: Number(process.env.WORKER_CONCURRENCY ?? "1"),
  });

  // Catch-all, distinct from runStep/processJob's own try/catch: covers any
  // job failure BullMQ records, including ones that never reached our own
  // logging — nothing about a failed render job goes unlogged.
  worker.on("failed", (job, error) => {
    console.error(`[worker] job ${job?.id ?? "-"} (session ${job?.data.sessionId ?? "-"}) FAILED:`, error.message);
  });
  // Previously unmonitored: BullMQ decides a job "stalled" (its lock wasn't
  // renewed in time) and silently reprocesses it from scratch — indistinguishable
  // from the outside from ordinary slowness, but it means real work is being
  // repeated and paid for twice. Two plausible causes here specifically: a
  // genuine Redis connectivity gap, or this process's event loop being blocked
  // long enough to miss a lock renewal — heal.ts/eyes.ts both run synchronous,
  // CPU-bound pixel loops directly on the event loop, which is exactly the kind
  // of thing that can do that on a large image.
  worker.on("stalled", (jobId) => {
    console.error(`[worker] job ${jobId} STALLED — BullMQ is reprocessing it. Check for a blocked event loop or a Redis blip.`);
  });
  worker.on("error", (error) => {
    console.error("[worker] worker-level error:", error.message);
  });

  return worker;
}

// The LOCAL-PIPELINE homepage — feed it photos in a browser, get finished
// pages back, calling the personalization pipeline directly, in-process.
//
//   npm run homepage:local        (then open http://localhost:5179)
//
// Deliberately ISOLATED from src/app.ts (the production Fastify app). That one
// needs Postgres, Redis, BullMQ and S3 to boot; this one needs none of them, so
// it can't be taken down by infrastructure that has nothing to do with the
// pipeline itself — useful for prompt/pipeline iteration without the full
// stack running. It calls exactly the same pipeline functions the production
// worker calls, so output is real, not a mock — it's just held in memory and
// streamed back over SSE instead of persisted to R2/Postgres.
//
// This is a restored copy of what `homepage/` was before it was rewritten to
// be a thin client of the real production API (session/R2/BullMQ) — kept
// side by side, not instead of, that version. Use this one for fast local
// pipeline iteration (no Postgres/Redis/R2 needed); use `homepage/` to
// exercise the real end-to-end product.
//
// Photos arrive as data URIs in a JSON body rather than multipart, because the
// pipeline already takes data URIs — that avoids adding @fastify/multipart just
// to convert one back into the other.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { PAGES, getPage, characterCount } from "../src/pipeline/catalog";
import { personalizePage } from "../src/pipeline/personalize";
import { mapWithConcurrency } from "../src/pipeline/pool";
import { dataUri } from "../src/pipeline/dataUri";
import { warmFaceDetector } from "../src/pipeline/faceDetect";
import { validatePhotoBuffer, ValidationError } from "../src/pipeline/validate";
import type { CharacterInput } from "../src/pipeline/types";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.HOMEPAGE_LOCAL_PORT ?? 5179);

// The UI offers two modes, which is just a split of the catalog by how many
// characters a page draws: "single" needs one photo, "multi" needs two.
//
// LOCAL-ONLY TRIM: "workshop" is excluded here — two solo scenes are enough
// for pipeline iteration on this surface. This filters homepage_local's OWN
// page list only; catalog.ts (PAGES/BOOKS) is untouched, so production
// (homepage/), the CLI, and the demo-book storyId all still have all three.
const LOCAL_EXCLUDED_SOLO_PAGES = new Set(["workshop"]);
const soloPages = Object.values(PAGES).filter(
  (p) => characterCount(p) === 1 && !LOCAL_EXCLUDED_SOLO_PAGES.has(p.id),
);
const duoPages = Object.values(PAGES).filter((p) => characterCount(p) > 1);

const DEFAULT_ESTIMATE_SECONDS = 120;
const estimate = (key: string): number => getPage(key).estimateSeconds ?? DEFAULT_ESTIMATE_SECONDS;

// Pages run in parallel, so the wall-clock estimate is the slowest one plus a
// little slack for the others queueing behind the concurrency limit.
const CONCURRENCY = 3;

const estimateFor = (keys: string[]): number => {
  const times = keys.map(estimate).sort((a, b) => b - a);
  const waves = Math.ceil(times.length / CONCURRENCY);
  return Math.round(times.slice(0, waves).reduce((a, b) => a + b, 0) * 1.1);
};

type Job = {
  id: string;
  mode: "single" | "multi";
  keys: string[];
  events: unknown[];
  done: boolean;
  error?: string;
  listeners: ((e: unknown) => void)[];
};
const jobs = new Map<string, Job>();

const emit = (job: Job, event: Record<string, unknown>) => {
  job.events.push(event);
  for (const l of job.listeners) l(event);
};

function decodePhoto(uri: string): { buf: Buffer; ext: "png" | "jpeg" } {
  const m = /^data:image\/(png|jpe?g);base64,(.+)$/i.exec(uri);
  if (!m) throw new Error("Photo must be a PNG or JPEG data URI.");
  const ext = m[1]!.toLowerCase().startsWith("jp") ? "jpeg" : "png";
  return { buf: Buffer.from(m[2]!, "base64"), ext };
}

/**
 * Both modes are the same call now — personalizePage routes on the page's own
 * character count, so the server doesn't need to know the difference.
 */
async function runPages(job: Job, photoUris: string[]): Promise<void> {
  console.log(`[homepage_local] job ${job.id}: starting ${job.keys.length} page(s): ${job.keys.join(", ")}`);
  const jobStarted = Date.now();
  // Photos map to the drawn characters left-to-right, same convention as the CLI.
  const characters: CharacterInput[] = photoUris.map((uri, i) => ({ slot: `child_${i + 1}`, photoUrl: uri }));
  await mapWithConcurrency(job.keys, CONCURRENCY, async (key) => {
    const started = Date.now();
    const secs = () => Math.round((Date.now() - started) / 1000);
    console.log(`[homepage_local] job ${job.id}: page "${key}" started`);
    emit(job, { type: "scene-start", key });
    try {
      let stageStarted = Date.now();
      const out = await personalizePage(getPage(key), characters, {
        onStage: (stage) => {
          const now = Date.now();
          console.log(`[homepage_local] job ${job.id}: page "${key}" stage "${stage}" finished in ${now - stageStarted}ms`);
          stageStarted = now;
          emit(job, { type: "stage", key, stage });
        },
      });
      console.log(`[homepage_local] job ${job.id}: page "${key}" DONE in ${secs()}s`);
      emit(job, { type: "scene-done", key, image: dataUri(out), seconds: secs() });
    } catch (err) {
      // Isolate the failure to THIS page: log the real cause to the terminal and
      // tell the browser which page failed and why. Without this, one page's error
      // rejected the whole job (mapWithConcurrency is fail-fast) and the UI blanked
      // every still-running page as "stopped" — which is exactly how a single
      // scene could "fail to display" with no visible reason.
      console.error(`[homepage_local] job ${job.id}: page "${key}" FAILED after ${secs()}s:`, err);
      emit(job, { type: "scene-error", key, message: (err as Error).message, seconds: secs() });
    }
  });
  console.log(`[homepage_local] job ${job.id}: ALL pages settled, total ${Date.now() - jobStarted}ms`);
}

const app = Fastify({ bodyLimit: 40 * 1024 * 1024, logger: false });

app.get("/", async (_req, reply) => {
  reply.type("text/html").send(await readFile(path.join(HERE, "index.html"), "utf8"));
});

app.get("/api/scenes", async () => ({
  single: soloPages.map((p) => ({ key: p.id, estimate: estimate(p.id) })),
  multi: duoPages.map((p) => ({ key: p.id, estimate: estimate(p.id) })),
}));

app.post("/api/run", async (req, reply) => {
  const body = req.body as { mode?: string; photos?: string[] };
  const mode = body.mode === "multi" ? "multi" : "single";
  const photos = Array.isArray(body.photos) ? body.photos : [];

  if (mode === "single" && photos.length !== 1) {
    return reply.code(400).send({ error: "Single-character mode needs exactly one photo." });
  }
  if (mode === "multi" && photos.length !== 2) {
    return reply.code(400).send({ error: "Multi-character mode needs exactly two photos (left, then right)." });
  }
  let decoded: { buf: Buffer; ext: "png" | "jpeg" }[];
  try {
    decoded = photos.map(decodePhoto);
  } catch (e) {
    return reply.code(400).send({ error: (e as Error).message });
  }

  // The SAME guard the production worker runs (min 200x200, exactly one clear
  // face), BEFORE any paid repaint/swap. A wrong upload — too small, no face, a
  // group photo — fails fast and free here with a friendly message, instead of
  // burning a repaint and then dying at the swap (the "no face" retry storm).
  try {
    await Promise.all(decoded.map((d) => validatePhotoBuffer(d.buf)));
  } catch (e) {
    if (e instanceof ValidationError) {
      console.log(`[homepage_local] photo validation rejected: ${e.message}`);
      return reply.code(400).send({ error: e.message });
    }
    throw e;
  }

  const keys = (mode === "single" ? soloPages : duoPages).map((p) => p.id);
  const job: Job = { id: Math.random().toString(36).slice(2, 10), mode, keys, events: [], done: false, listeners: [] };
  jobs.set(job.id, job);
  console.log(`[homepage_local] job ${job.id} created (mode: ${mode}, pages: ${keys.join(", ")})`);

  // Fire and forget — the browser follows progress over SSE.
  void (async () => {
    try {
      await runPages(job, photos);
      console.log(`[homepage_local] job ${job.id}: done`);
      emit(job, { type: "done" });
    } catch (e) {
      job.error = (e as Error).message;
      console.error(`[homepage_local] job ${job.id}: FAILED:`, job.error);
      emit(job, { type: "error", message: job.error });
    } finally {
      job.done = true;
      // Give a late-connecting browser a window to drain the buffered events.
      setTimeout(() => jobs.delete(job.id), 10 * 60 * 1000);
    }
  })();

  return { jobId: job.id, keys, estimateSeconds: estimateFor(keys) };
});

app.get("/api/run/:id/events", async (req, reply) => {
  const job = jobs.get((req.params as { id: string }).id);
  if (!job) return reply.code(404).send({ error: "Unknown job" });

  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const send = (e: unknown) => reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
  // Replay anything that happened before this connection opened, then stream.
  for (const e of job.events) send(e);
  if (!job.done) {
    job.listeners.push(send);
    req.raw.on("close", () => {
      job.listeners = job.listeners.filter((l) => l !== send);
    });
  } else {
    reply.raw.end();
  }
});

// Pays the one-time blazeface model load (~5-13s, measured) during boot
// instead of on whichever request happens to hit face detection first.
await warmFaceDetector();

const address = await app.listen({ port: PORT, host: "0.0.0.0" });
console.log(`\n  Local-pipeline homepage running at ${address.replace("0.0.0.0", "localhost")}\n`);

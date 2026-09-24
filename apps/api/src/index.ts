// Combined dev-convenience entry point: API + worker in ONE process, for
// low-friction local iteration. server.ts + worker-process.ts is the same
// pair split across two processes, so the worker's CPU-bound pipeline work
// (sharp, TF.js face detection, base64 encode/decode of image buffers)
// can't stall this process's ability to serve HTTP/SSE — that split is what
// `npm run server` + `npm run worker` gives you and what production should
// run. Kept because it's what `npm run dev`/`npm start` already point to and
// what the demo has been verified against; not being removed to avoid
// breaking that.
import { buildApp } from "./app";
import { env, missingDay1Config } from "./env";
import { startPipelineWorker } from "./worker";
import { startFulfillmentWorker } from "./fulfillmentWorker";
import { startGdprWorker } from "./gdprWorker";

const missing = missingDay1Config();
if (missing.length > 0) {
  console.warn(
    `[startup] Missing config for: ${missing.join(", ")}. Endpoints needing these will 500 until apps/api/.env is set — see .env.example.`,
  );
}
if (!env.REDIS_URL) {
  console.warn(
    "[startup] REDIS_URL not configured — the pipeline, fulfilment and GDPR deletion workers will not start (paid orders cannot be fulfilled, photos are not auto-deleted); upload-confirm will skip enqueueing and /status will 503.",
  );
}

const app = await buildApp();
const worker = env.REDIS_URL ? startPipelineWorker() : undefined;
const fulfillmentWorker = env.REDIS_URL ? startFulfillmentWorker() : undefined;
const gdprWorker = env.REDIS_URL ? startGdprWorker() : undefined;

app.listen({ port: env.PORT, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});

async function shutdown() {
  await worker?.close();
  await fulfillmentWorker?.close();
  await gdprWorker?.close();
  await app.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

import { buildApp } from "./app";
import { env, missingDay1Config } from "./env";

// API process ONLY — no BullMQ worker here. This is the deliberate split from
// index.ts (which still runs both in one process, for low-friction local dev):
// the worker's per-job work (sharp image ops, TF.js face detection, base64
// encode/decode of multi-MB page buffers) is synchronous, CPU-bound JS that
// blocks whatever event loop it runs on. Sharing that loop with the HTTP
// server meant a page mid-render could stall this process's ability to accept
// new connections, serve /health, or flush an SSE event on time. Running the
// worker in its own OS process (see worker-process.ts) means its blocking work
// only ever blocks itself — this process stays free to talk to the frontend
// and enqueue/read Postgres+R2+Redis, which is all genuinely async I/O.
//
// Run alongside `npm run worker` (worker-process.ts). Both read the same
// REDIS_URL/DATABASE_URL/R2_* — they coordinate purely through Postgres, R2,
// and the BullMQ queue, never by sharing memory.

const missing = missingDay1Config();
if (missing.length > 0) {
  console.warn(
    `[startup] Missing config for: ${missing.join(", ")}. Endpoints needing these will 500 until apps/api/.env is set — see .env.example.`,
  );
}
if (!env.REDIS_URL) {
  console.warn(
    "[startup] REDIS_URL not configured — upload-confirm will skip enqueueing and /status will 503. " +
      "(The pipeline worker itself lives in a separate process now — see `npm run worker`.)",
  );
}

const app = await buildApp();

app.listen({ port: env.PORT, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});

async function shutdown() {
  await app.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

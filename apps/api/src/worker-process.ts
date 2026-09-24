import { env } from "./env";
import { startPipelineWorker } from "./worker";
import { startFulfillmentWorker } from "./fulfillmentWorker";
import { startGdprWorker } from "./gdprWorker";

// Worker process ONLY (pipeline + fulfilment + GDPR deletion workers), no Fastify server here. Companion to
// server.ts; see the comment there for why these are split. This process's
// entire job is to sit on the BullMQ queue and burn CPU on repaint/swap/
// restore/heal/eyes without anything depending on its event loop staying
// responsive on a tight deadline — unlike the API process, a render taking an
// extra few hundred ms because this loop was busy is invisible to the user.

if (!env.REDIS_URL) {
  console.error(
    "[startup] REDIS_URL not configured — the pipeline worker has nothing to connect to. Set REDIS_URL in apps/api/.env.",
  );
  process.exit(1);
}

const worker = startPipelineWorker();
console.log("[worker] pipeline worker started — waiting for jobs on the \"pipeline\" queue.");
const fulfillmentWorker = startFulfillmentWorker();
console.log("[worker] fulfilment worker started — waiting for jobs on the \"fulfillment\" queue.");
const gdprWorker = startGdprWorker();
console.log("[worker] GDPR deletion worker started — sweeping on the \"gdpr\" queue.");

async function shutdown() {
  await worker.close();
  await fulfillmentWorker.close();
  await gdprWorker.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

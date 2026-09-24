import { Redis, type RedisOptions } from "ioredis";
import { env } from "./env";

function baseConnection(options: RedisOptions): Redis {
  if (!env.REDIS_URL) {
    throw new Error("REDIS_URL is not configured.");
  }
  const connection = new Redis(env.REDIS_URL, options);
  // Without a listener, ioredis re-throws connection errors as uncaught
  // exceptions (Node's default EventEmitter behavior for unhandled "error"
  // events) — a single transient network blip on any connection (e.g. one
  // SSE subscriber) would otherwise crash the entire server process.
  connection.on("error", (error) => {
    console.error("[redis] connection error:", error.message);
  });
  return connection;
}

// For BullMQ Worker/QueueEvents connections, and anything else that blocks
// waiting on Redis (e.g. the rate limiter's own poll-and-retry loop): these
// must survive a transient disconnect by waiting indefinitely rather than
// throwing, per BullMQ's own production guidance
// (https://docs.bullmq.io/guide/going-to-production) — a Worker that gives up
// mid-blip stops processing jobs instead of just pausing briefly.
export function createRedisConnection(): Redis {
  return baseConnection({ maxRetriesPerRequest: null });
}

// For BullMQ Queue connections specifically (queue.add() and friends): the
// same guidance says these should FAIL FAST on a disconnect instead of
// hanging — a stuck queue.add() during a network blip should surface as an
// error on the HTTP request that triggered it, not hang silently. This
// project previously used the Worker-style (maxRetriesPerRequest: null)
// connection for its Queue instances too — one connection factory
// copy-pasted for both roles — which is exactly the mismatch BullMQ's docs
// warn against. Uses ioredis's own default retry behavior (finite retries,
// then fail) by simply not overriding it.
export function createQueueRedisConnection(): Redis {
  return baseConnection({});
}

import { EventEmitter } from "node:events";
import type { Redis } from "ioredis";
import { createRedisConnection } from "./redis";
import type { PipelineStep } from "./pipeline/types";

export type StatusEvent =
  // `page` + `stage` are only set for the "render" step, letting a client route
  // progress to a specific page's card instead of one line for the whole batch.
  | { type: "status"; step: PipelineStep; slot?: string; page?: string; stage?: string; message: string }
  | { type: "done"; previewUrl: string }
  | { type: "error"; step: PipelineStep; slot?: string; page?: string; message: string };

function channelFor(sessionId: string): string {
  return `session:${sessionId}`;
}

let publisher: Redis | undefined;
function getPublisher(): Redis {
  publisher ??= createRedisConnection();
  return publisher;
}

export async function publishStatus(sessionId: string, event: StatusEvent): Promise<void> {
  await getPublisher().publish(channelFor(sessionId), JSON.stringify(event));
}

// ONE shared Redis connection, pattern-subscribed to every session's channel,
// fanning out to in-process listeners keyed by sessionId — not one Redis
// connection per SSE request.
//
// The previous version called createRedisConnection() fresh inside every
// subscribeStatus() call — one new Redis connection per open SSE tab, and a
// FRESH one again on every browser reconnect (EventSource retries
// automatically on any drop). Verified live: a burst of reconnects tripped
// Upstash's connection limits, which surfaced as ECONNRESET and even
// getaddrinfo ENOTFOUND for the Redis host — a self-inflicted reconnect storm,
// not a real outage (a single plain connection worked fine immediately after).
// A pattern subscription on one long-lived connection makes Redis connection
// count O(1) in the number of concurrent SSE viewers, not O(n), and ioredis
// auto-reconnects + auto-resubscribes this connection on a genuine drop, so a
// real network blip self-heals without any bespoke retry logic here.
const SESSION_CHANNEL_PATTERN = "session:*";
const emitter = new EventEmitter();
emitter.setMaxListeners(0); // many concurrent SSE viewers is normal, not a leak

let sharedSubscriber: Redis | undefined;
function ensureSharedSubscriber(): Redis {
  if (sharedSubscriber) return sharedSubscriber;
  const sub = createRedisConnection();
  sub.psubscribe(SESSION_CHANNEL_PATTERN).catch((error) => {
    console.error("[status-events] psubscribe failed:", (error as Error).message);
  });
  sub.on("pmessage", (_pattern: string, channel: string, message: string) => {
    const sessionId = channel.slice("session:".length);
    emitter.emit(sessionId, JSON.parse(message) as StatusEvent);
  });
  sharedSubscriber = sub;
  return sharedSubscriber;
}

// Returns an unsubscribe function. No network call on either end — this only
// ever touches the in-process listener registry; the underlying Redis
// subscription is shared and never torn down per-caller.
export function subscribeStatus(
  sessionId: string,
  onEvent: (event: StatusEvent) => void,
): () => Promise<void> {
  ensureSharedSubscriber();
  emitter.on(sessionId, onEvent);
  return async () => {
    emitter.off(sessionId, onEvent);
  };
}

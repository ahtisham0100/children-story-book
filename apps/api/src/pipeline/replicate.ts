import { randomUUID } from "node:crypto";
import { env } from "../env";
import { fetchWithRetry } from "./retry";
import { createRedisConnection } from "../redis";

interface Account {
  label: string;
  token: string;
}

// Ordered: primary always tried first. A second account
// (REPLICATE_API_TOKEN_FALLBACK) is optional — with it unset, every function
// below degenerates to exactly the original single-account behavior.
function getAccounts(): Account[] {
  const accounts: Account[] = [];
  if (env.REPLICATE_API_TOKEN) accounts.push({ label: "primary", token: env.REPLICATE_API_TOKEN });
  if (env.REPLICATE_API_TOKEN_FALLBACK) accounts.push({ label: "fallback", token: env.REPLICATE_API_TOKEN_FALLBACK });
  return accounts;
}

// Stated loudly, once, at module load — not left to be inferred from behavior.
// Any process that imports this file (CLI, homepage_local, or a production
// process) prints exactly which rate-limit strategy it's running and how many
// accounts it knows about, so there's never doubt about whether a given
// process is coordinating with others or has a fallback account available.
console.log(
  (env.REDIS_URL
    ? "[replicate] rate limiter: DISTRIBUTED (Redis-backed, shared across every process using this account)"
    : "[replicate] rate limiter: local in-memory (no REDIS_URL — correct only if this is the sole process calling Replicate)") +
    ` — ${getAccounts().length} account(s) configured` +
    (getAccounts().length > 1 ? " (rate-limit hits switch accounts immediately instead of waiting)" : ""),
);

export class ReplicateError extends Error {}

interface Prediction {
  id: string;
  status: "starting" | "processing" | "succeeded" | "failed" | "canceled";
  output?: string | string[];
  error?: string | null;
  // The model's own stdout. The swap model can report `status: "succeeded"`
  // with no output and only "No face found" in the logs.
  logs?: string | null;
  urls: { get: string };
}

const TERMINAL = ["succeeded", "failed", "canceled"];

// Proactive throttle on prediction STARTS (not polling — `Prefer: wait` means
// polling rarely fires). Without this, PAGE_CONCURRENCY=3 fires up to 9 hosted
// calls (repaint+swap+restore x3 pages) in a few seconds, blows past the
// account's rate limit, and every 429 pays a silent 10s+ backoff in
// fetchWithRetry — that's what stretched a ~60-75s single-page render to
// 3:44 for 3 concurrent solo pages. Spacing starts to the known limit avoids
// hitting 429 in the first place. Replicate limits per ACCOUNT, not per
// request or per process — tune via env if the account's actual limit
// differs from the documented 6/min.
const RATE_LIMIT_PER_MIN = Number(process.env.REPLICATE_RATE_LIMIT_PER_MIN ?? "6");
const RATE_LIMIT_WINDOW_MS = 60_000;

// TWO implementations, chosen once at import time:
//
//   in-memory (no REDIS_URL) — a plain Map of arrays, one per account label,
//     exactly as this always worked (just keyed by account now). Correct as
//     long as ONE process makes every Replicate call, which is true for the
//     CLI and homepage_local (no queue infra, by design) and for worker.ts's
//     default STAGE_EXECUTION=direct mode.
//
//   Redis-backed (REDIS_URL set) — a sliding-window counter in a Redis sorted
//     set PER ACCOUNT, checked+incremented atomically via a Lua script (EVAL
//     is single-threaded in Redis, so concurrent callers can't both slip
//     through on the same slot). REQUIRED once STAGE_EXECUTION=queued is on:
//     repaint, swap and restore then each run in their OWN process
//     (stage-worker.ts), so an in-memory counter would only ever see its own
//     process's calls. Sharing the counter through Redis makes the limit
//     account-wide again, regardless of how many processes are making calls.
const localRateLimitWindows = new Map<string, number[]>(); // in-memory fallback only

let rateLimitRedis: ReturnType<typeof createRedisConnection> | undefined;
function getRateLimitRedis() {
  rateLimitRedis ??= createRedisConnection();
  return rateLimitRedis;
}

function rateLimitKey(label: string): string {
  return `replicate:rate-limit:${label}`;
}

// KEYS[1]=key ARGV[1]=now ARGV[2]=window ARGV[3]=limit ARGV[4]=member
// Returns 0 if a slot was acquired (and records it), otherwise 1.
// Deliberately does NOT return "how long until a slot frees up" anymore —
// callers don't wait on one account, they move on to the next one
// immediately (see tryAcquireSlotOnce/postPrediction below), so that
// information has nothing to do with.
const RATE_LIMIT_SCRIPT = `
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', tonumber(ARGV[1]) - tonumber(ARGV[2]))
  local count = redis.call('ZCARD', KEYS[1])
  if count < tonumber(ARGV[3]) then
    redis.call('ZADD', KEYS[1], ARGV[1], ARGV[4])
    redis.call('PEXPIRE', KEYS[1], ARGV[2])
    return 0
  end
  return 1
`;

/** Single non-blocking check: does this account have room for one more call right now? */
async function tryAcquireSlotOnce(label: string): Promise<boolean> {
  if (env.REDIS_URL) {
    const now = Date.now();
    const result = await getRateLimitRedis().eval(
      RATE_LIMIT_SCRIPT,
      1,
      rateLimitKey(label),
      now,
      RATE_LIMIT_WINDOW_MS,
      RATE_LIMIT_PER_MIN,
      `${now}-${randomUUID()}`,
    );
    return Number(result) === 0;
  }
  const now = Date.now();
  const window = localRateLimitWindows.get(label) ?? [];
  while (window.length > 0 && now - (window[0] as number) >= RATE_LIMIT_WINDOW_MS) window.shift();
  if (window.length < RATE_LIMIT_PER_MIN) {
    window.push(now);
    localRateLimitWindows.set(label, window);
    return true;
  }
  localRateLimitWindows.set(label, window);
  return false;
}

/**
 * Sends the prediction-create request, switching Replicate accounts
 * immediately on a 429 instead of backing off — tries every configured
 * account once (skipping any without proactive rate-limit room, and moving
 * on the instant one returns an actual 429) before ever sleeping. Only if
 * literally every account is exhausted does it fall back to the original
 * patient wait-and-retry behavior, on the primary account, as a safety net.
 */

// Rotates which account gets tried FIRST on each call, instead of always
// starting from accounts[0] (primary). Without this, a concurrent burst
// (several pages rendering at once) has every one of those calls try primary
// first, piling them all onto ONE account's budget almost simultaneously —
// confirmed live: repeated "429 on primary" collisions even with a second
// account configured, because the fallback barely got used until primary was
// already exhausted. Alternating the starting account spreads a burst across
// both accounts' budgets from the first call, roughly doubling effective
// burst capacity for concurrent renders. Plain in-memory counter — safe
// without synchronization since the increment is a single synchronous
// statement (JS has no mid-statement interleaving), and this only needs to
// coordinate calls within THIS process, which is exactly where a concurrent
// burst (mapWithConcurrency across pages/characters) actually happens.
let nextAccountStart = 0;
function rotateAccounts(accounts: Account[]): Account[] {
  if (accounts.length <= 1) return accounts;
  const start = nextAccountStart % accounts.length;
  nextAccountStart += 1;
  return [...accounts.slice(start), ...accounts.slice(0, start)];
}

async function postPrediction(
  url: string,
  bodyStr: string,
  accountsInPriorityOrder: Account[],
): Promise<{ res: Response; account: Account }> {
  const headersFor = (token: string) => ({
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Prefer: "wait",
  });

  const accounts = rotateAccounts(accountsInPriorityOrder);
  for (const account of accounts) {
    if (!(await tryAcquireSlotOnce(account.label))) continue; // no room — try the next account, no wait
    const res = await fetchWithRetry(url, { method: "POST", headers: headersFor(account.token), body: bodyStr }, 3, 1500, {
      retryOn429: false,
    });
    if (res.status !== 429) return { res, account };
    console.error(`[replicate] 429 on account "${account.label}" (proactive slot said OK, Replicate disagreed) — trying the next account immediately.`);
  }

  const fallbackWait = accounts[0] as Account;
  console.error(`[replicate] every account rate-limited — falling back to waiting on "${fallbackWait.label}".`);
  const res = await fetchWithRetry(url, { method: "POST", headers: headersFor(fallbackWait.token), body: bodyStr }, 3, 1500, {
    retryOn429: true,
  });
  return { res, account: fallbackWait };
}

/**
 * Runs one Replicate prediction to completion and returns its output URL.
 *
 * `body` is sent as-is, so the caller decides the endpoint shape:
 *   - version-based:      path "predictions",                     body { version, input }
 *   - model-scoped:       path "models/<owner>/<name>/predictions", body { input }
 *
 * `Prefer: wait` means the common (warm) case returns without polling; the loop
 * covers cold starts. Network/5xx retries are handled by fetchWithRetry; a 429
 * switches accounts immediately (see postPrediction) rather than backing off.
 *
 * `noFaceRetries` covers a different failure: the swap model can return
 * `status: "succeeded"` with no output and only "No face found" in its logs —
 * a false negative from its own face detector, not a fetchWithRetry-visible
 * HTTP error. Confirmed transient by hand: resubmitting the exact same
 * target+photo bytes that failed this way succeeded on the very next call.
 * Retrying costs one more paid prediction, so it's bounded and off by default;
 * only swapIdentity (the caller that actually sees this failure mode) opts in.
 */
export async function runReplicate(path: string, body: Record<string, unknown>, noFaceRetries = 0): Promise<string> {
  const accounts = getAccounts();
  if (accounts.length === 0) throw new ReplicateError("No REPLICATE_API_TOKEN configured.");

  for (let attempt = 0; ; attempt += 1) {
    const { res, account } = await postPrediction(`https://api.replicate.com/v1/${path}`, JSON.stringify(body), accounts);
    if (!res.ok) throw new ReplicateError(`Replicate ${path} failed (${res.status}): ${await res.text()}`);

    let pred = (await res.json()) as Prediction;
    for (let i = 0; i < 90 && !TERMINAL.includes(pred.status); i += 1) {
      await new Promise((r) => setTimeout(r, 2000));
      const poll = await fetchWithRetry(pred.urls.get, { headers: { Authorization: `Bearer ${account.token}` } });
      pred = (await poll.json()) as Prediction;
    }

    if (pred.status !== "succeeded" || !pred.output) {
      const noFace = pred.logs?.includes("No face found") ?? false;
      if (noFace && attempt < noFaceRetries) {
        console.error(`[replicate] ${path}: model reported "No face found" (attempt ${attempt + 1}/${noFaceRetries + 1}) — retrying`);
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      throw new ReplicateError(
        noFace
          ? "Couldn't find a usable face in the photo or the artwork."
          : (pred.error ?? `Replicate ${path} produced no output (status: ${pred.status}).`),
      );
    }
    const output = Array.isArray(pred.output) ? pred.output[0] : pred.output;
    if (!output) throw new ReplicateError(`Replicate ${path} returned an empty output.`);
    return output;
  }
}

/** Downloads a Replicate output URL to a Buffer (with the same retry policy). */
export async function fetchToBuffer(url: string): Promise<Buffer> {
  const res = await fetchWithRetry(url, {});
  if (!res.ok) throw new ReplicateError(`Failed to download Replicate output (${res.status}).`);
  return Buffer.from(await res.arrayBuffer());
}

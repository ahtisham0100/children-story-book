import { randomUUID } from "node:crypto";
import { runReplicate, fetchToBuffer, ReplicateError } from "../replicate";
import { dataUri } from "../dataUri";
import { env } from "../../env";
import { createRedisConnection } from "../../redis";

// STAGE 2 of 5 — sharpen identity to exactly this child.
//
// The repaint gets the child broadly right; this pins the likeness.
//
// TWO BACKENDS, one contract. `SWAP_BACKEND` selects:
//
//   replicate (default) — hosted. Tries the codeplugtech/face-swap DEPLOYMENT
//                         (dedicated T4 GPU) first, falls back to the plain
//                         ddvinh1/face-swap-gpu model call on any failure — see
//                         swapViaReplicate below.
//   local               — services/faceswap, the same inswapper model self-hosted.
//                         Errors if the service is down (strict; for testing).
//   auto                — try local first, fall back to hosted on ANY local
//                         failure. Fast when the box is healthy, slow-but-working
//                         when it isn't. The production-resilient setting.
//
// WHY LOCAL EXISTS: the hosted call bills ~$0.006 at Replicate's CPU rate of
// $0.0001/s, i.e. ~60 SECONDS of billed CPU, for a model whose real inference is
// under a second. The minute is cold start — it reloads several hundred MB of
// weights per call. Self-hosted with resident models the stage drops from
// ~55-90s to ~3.5s (measured), taking a page from ~90-170s to ~15-25s. That is what
// makes full-book rendering viable at all. See services/faceswap/README.md.
//
// Default stays `replicate` on purpose: the local service needs weights that are
// not in this repo, so anyone without it running is unaffected.
//
// LICENSING: both backends run InsightFace's inswapper, which is
// non-commercial/research licensed. Self-hosting does not change that. Most open
// face-swap tools (roop, facefusion, SimSwap) derive from the same model and
// inherit the restriction. This must be resolved before the product is sold.

// PRIMARY (2026-07-23): a Replicate DEPLOYMENT — codeplugtech/face-swap
// (the same model previously run generically on CPU, ~55-90s) now pinned to a
// dedicated Nvidia T4 GPU instance, owned by the "ihtesham" Replicate org.
// Deployments use their own endpoint shape (deployments/<owner>/<name>/
// predictions, no `version` field — the deployment itself pins the version)
// and their own token (REPLICATE_API_TOKEN was switched globally to this
// org's token at the user's explicit instruction — repaint/restore now
// authenticate as this account too).
const FACE_SWAP_DEPLOYMENT_OWNER = "ihtesham";
const FACE_SWAP_DEPLOYMENT_NAME = "face-swap";

// FALLBACK: the plain (non-deployment) model call this project used right
// before the deployment above — ddvinh1/face-swap-gpu, ~1s warm/22s cold,
// ~$0.0002/call. Pinned to a version hash because the version-based
// /predictions endpoint requires one, and pinning stops behaviour drifting if
// the owner pushes an update. Used automatically if the deployment call
// fails for any reason (see swapViaReplicate) — e.g. the deployment's single
// max instance is still cold-starting, or Replicate has an issue scoped to
// deployments specifically. Same input contract either way (input_image =
// target artwork, swap_image = child photo).
const FACE_SWAP_FALLBACK_VERSION = "d766886cf43ea2e9821703c392e3d403d2311eb8d013feef924655f9b7e2971d";

// THROTTLE for the deployment specifically (2026-07-24). The deployment is
// configured with max_instances: 1 (Cloudflare/Replicate dashboard setting,
// not code) — firing more than one concurrent call at it doesn't parallelize
// anything, it just contends for the single instance. Confirmed live: doing
// exactly that produced real 429s from Replicate on the deployment endpoint.
//
// This gate limits in-flight deployment calls to DEPLOYMENT_MAX_CONCURRENT
// (default 1, matching max_instances) and, critically, RELEASES THE INSTANT a
// call finishes — success or failure — so the next waiting call starts almost
// immediately (bounded only by the poll interval), rather than idling and
// risking the single instance scaling back down between requests. A waiter
// gives up after DEPLOYMENT_LOCK_WAIT_BUDGET_MS and falls straight to the
// plain model call instead of queueing indefinitely behind a busy or stuck
// instance — the render pipeline keeps moving either way.
//
// Same dual-mode pattern as replicate.ts's rate limiter: Redis-backed (shared
// across every stage-worker process) when REDIS_URL is set, in-memory
// fallback otherwise — correct for the CLI/homepage_local, which are always a
// single process, but can still run swap concurrently across character crops
// on a multi-character page, so even the in-memory case needs a real gate,
// not just a comment saying "don't."
const DEPLOYMENT_MAX_CONCURRENT = Number(process.env.SWAP_DEPLOYMENT_MAX_CONCURRENT ?? "1");
const DEPLOYMENT_LOCK_KEY = "swap:deployment:concurrency";
const DEPLOYMENT_LOCK_STALE_MS = 240_000; // safety net only (crashed holder) — normal release is explicit, see above
const DEPLOYMENT_LOCK_POLL_MS = 300;
const DEPLOYMENT_LOCK_WAIT_BUDGET_MS = 20_000;

let deploymentGateRedis: ReturnType<typeof createRedisConnection> | undefined;
function getDeploymentGateRedis() {
  deploymentGateRedis ??= createRedisConnection();
  return deploymentGateRedis;
}

// KEYS[1]=key ARGV[1]=now ARGV[2]=staleAfterMs ARGV[3]=maxConcurrent ARGV[4]=member
// Same sliding-window-via-sorted-set shape as replicate.ts's rate limiter,
// verified working there. Returns 1 if a slot was acquired, 0 otherwise.
const DEPLOYMENT_GATE_ACQUIRE_SCRIPT = `
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', tonumber(ARGV[1]) - tonumber(ARGV[2]))
  local count = redis.call('ZCARD', KEYS[1])
  if count < tonumber(ARGV[3]) then
    redis.call('ZADD', KEYS[1], ARGV[1], ARGV[4])
    redis.call('PEXPIRE', KEYS[1], ARGV[2])
    return 1
  end
  return 0
`;

let localDeploymentSlotsInUse = 0;

/**
 * Waits (bounded) for a free deployment slot. Returns a release function on
 * success, or `null` if the wait budget was exhausted — the caller's job is
 * to treat `null` as "skip the deployment, use the fallback directly."
 */
async function acquireDeploymentSlot(): Promise<(() => Promise<void>) | null> {
  const deadline = Date.now() + DEPLOYMENT_LOCK_WAIT_BUDGET_MS;
  for (;;) {
    if (env.REDIS_URL) {
      const now = Date.now();
      const member = `${now}-${randomUUID()}`;
      const acquired = Number(
        await getDeploymentGateRedis().eval(
          DEPLOYMENT_GATE_ACQUIRE_SCRIPT,
          1,
          DEPLOYMENT_LOCK_KEY,
          now,
          DEPLOYMENT_LOCK_STALE_MS,
          DEPLOYMENT_MAX_CONCURRENT,
          member,
        ),
      );
      if (acquired === 1) {
        return async () => {
          await getDeploymentGateRedis().zrem(DEPLOYMENT_LOCK_KEY, member);
        };
      }
    } else if (localDeploymentSlotsInUse < DEPLOYMENT_MAX_CONCURRENT) {
      localDeploymentSlotsInUse += 1;
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        localDeploymentSlotsInUse -= 1;
      };
    }
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, DEPLOYMENT_LOCK_POLL_MS));
  }
}

// Both backends' face detectors false-negative ("No face found") on some
// target/photo pairs far more than others. Two causes were found and fixed
// upstream of here — chibi-styled source art the detector can't parse (now
// countered by REPAINT_PROMPT's facial-proportions clause) and repaint output
// geometry resolving against the photo instead of the template (now pinned by
// the repaint stage's aspect_ratio). Retries remain as cheap insurance for
// ordinary flakiness. Do NOT read a high retry count as a reliability guarantee:
// a pairing that fails systematically has historically failed all 5 attempts.
const NO_FACE_RETRIES = 4;

/** The one user-facing message for a detection miss, whichever backend produced it. */
const NO_FACE_MESSAGE = "Couldn't find a usable face in the photo or the artwork.";

/** Thrown for a detection miss specifically, so the retry loop can tell it apart. */
class NoFaceError extends Error {}

/**
 * Resolves the photo to raw base64.
 *
 * The hosted model takes a URL or data URI and fetches it itself; the local
 * service takes bytes. In production `photoUri` is an R2 signed URL, so this
 * has to handle both forms.
 */
async function toBase64(photoUri: string): Promise<string> {
  if (photoUri.startsWith("data:")) return photoUri.slice(photoUri.indexOf(",") + 1);
  const buf = await fetchToBuffer(photoUri);
  return buf.toString("base64");
}

async function swapViaLocal(targetBuf: Buffer, photoUri: string): Promise<Buffer> {
  const base = env.SWAP_LOCAL_URL.replace(/\/$/, "");

  let res: Response;
  try {
    res = await fetch(`${base}/swap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input_image: targetBuf.toString("base64"),
        swap_image: await toBase64(photoUri),
      }),
    });
  } catch (cause) {
    // A connection refusal here is almost always "the service isn't running",
    // which is worth saying plainly rather than surfacing a bare ECONNREFUSED.
    throw new ReplicateError(
      `Local swap service unreachable at ${base}. Is it running? ` +
        `(cd services/faceswap && python app.py). Set SWAP_BACKEND=replicate to use the hosted model instead. ` +
        `Cause: ${(cause as Error).message}`,
    );
  }

  if (res.status === 422) {
    throw new NoFaceError(NO_FACE_MESSAGE);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ReplicateError(`Local swap service failed (${res.status}): ${body.slice(0, 400)}`);
  }

  const json = (await res.json()) as { image?: string };
  if (!json.image) throw new ReplicateError("Local swap service returned no image.");
  return Buffer.from(json.image, "base64");
}

async function swapViaDeployment(targetBuf: Buffer, photoUri: string): Promise<Buffer> {
  const url = await runReplicate(
    `deployments/${FACE_SWAP_DEPLOYMENT_OWNER}/${FACE_SWAP_DEPLOYMENT_NAME}/predictions`,
    { input: { input_image: dataUri(targetBuf), swap_image: photoUri } },
    NO_FACE_RETRIES,
  );
  return fetchToBuffer(url);
}

async function swapViaFallbackVersion(targetBuf: Buffer, photoUri: string): Promise<Buffer> {
  const url = await runReplicate(
    "predictions",
    { version: FACE_SWAP_FALLBACK_VERSION, input: { input_image: dataUri(targetBuf), swap_image: photoUri } },
    NO_FACE_RETRIES,
  );
  return fetchToBuffer(url);
}

/**
 * Hosted swap: defaults straight to the plain fallback model version, NOT the
 * dedicated-GPU deployment. The deployment is owned by a specific Replicate
 * account (FACE_SWAP_DEPLOYMENT_OWNER); now that runReplicate can transparently
 * switch between two different accounts on a rate limit (see replicate.ts),
 * a deployment tied to one specific account is no longer a safe default — the
 * fallback-triggered account might not have access to it. The plain model
 * version is a public model callable from either account, so it's the correct
 * default now. `swapViaDeployment`/`acquireDeploymentSlot` are kept intact
 * below, dormant, in case the deployment is revisited later (e.g. pinned to
 * whichever account actually owns it, called only when that specific account
 * is in use).
 */
async function swapViaReplicate(targetBuf: Buffer, photoUri: string): Promise<Buffer> {
  return swapViaFallbackVersion(targetBuf, photoUri);
}

/**
 * Local swap with its own retry loop. Retries here rather than inside the client
 * because a local retry is ~3.5s and free — the hosted one costs a paid
 * prediction and ~60s, which is why that budget is bounded and lives deeper in
 * the stack. Throws on exhaustion (a NoFaceError) or a hard failure (unreachable,
 * 5xx) — the caller decides whether that's fatal or a reason to fall back.
 */
async function swapViaLocalWithRetries(targetBuf: Buffer, photoUri: string): Promise<Buffer> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await swapViaLocal(targetBuf, photoUri);
    } catch (err) {
      if (err instanceof NoFaceError && attempt < NO_FACE_RETRIES) {
        console.error(
          `[swap:local] detector reported no face (attempt ${attempt + 1}/${NO_FACE_RETRIES + 1}) — retrying`,
        );
        continue;
      }
      throw err;
    }
  }
}

/** Replace the repainted face with the child's actual face. */
export async function swapIdentity(targetBuf: Buffer, photoUri: string): Promise<Buffer> {
  const backend = env.SWAP_BACKEND;
  if (backend === "replicate") return swapViaReplicate(targetBuf, photoUri);

  try {
    return await swapViaLocalWithRetries(targetBuf, photoUri);
  } catch (err) {
    // `auto`: a healthy local box is the fast path, but any local failure —
    // service down, 5xx, or no-face after local retries — falls back to the
    // hosted model rather than failing the render. Logged loudly so a silently
    // degraded box (every swap quietly paying full hosted price) is visible in
    // the logs instead of just looking slow.
    if (backend === "auto") {
      console.error(`[swap] local backend failed — falling back to hosted. Cause: ${(err as Error).message}`);
      return swapViaReplicate(targetBuf, photoUri);
    }
    // `local` (strict): surface a no-face as the friendly message, else the raw error.
    if (err instanceof NoFaceError) throw new ReplicateError(err.message);
    throw err;
  }
}

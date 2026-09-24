# Infra & pipeline trace: R2, Redis, Postgres, and where Replicate is called

A line-by-line trace of the production path (`npm run dev` → `homepage`), answering
four specific questions: what R2 does, what Redis does, what Postgres does, and
where to change the swap model. For the wider "what is this project" picture, see
[`PROTOTYPE_OVERVIEW.md`](PROTOTYPE_OVERVIEW.md) — this doc goes deeper on infra only.

All file paths below are relative to `apps/api/`.

---

## 1. The three infra pieces, one sentence each

| Piece | Role | Touches the pipeline itself? |
|---|---|---|
| **Postgres** (Neon, via Prisma) | Source of truth for *session/character state* — who uploaded what, what status a render is in | No — never touches image bytes |
| **R2** (Cloudflare, via S3-compatible SDK) | Stores every *image byte* — raw uploads and finished pages | No — dumb blob store, pipeline just gets Buffers in/out |
| **Redis** (Upstash, via ioredis) | Two unrelated jobs: (a) BullMQ's job queue, (b) pub/sub for live SSE progress | No — purely plumbing between processes |

None of the three ever sees a Replicate call directly. They coordinate *when* and
*with what data* the pipeline (`src/pipeline/`) runs; the pipeline itself is the only
thing that talks to Replicate.

---

## 2. Postgres — session & character bookkeeping

**Files:** [`src/db.ts`](../apps/api/src/db.ts), [`prisma/schema.prisma`](../apps/api/prisma/schema.prisma)

`db.ts` is a single exported Prisma client (`prisma`), pointed at `DATABASE_URL`. Two
models, both tiny:

```prisma
model Session {
  id, locale, storyId, status   // created | uploaded | processing | done | failed
  previewKey                     // R2 key of the first finished page
  characters  Character[]
}

model Character {
  id, sessionId, slot            // "child_1", "child_2" — which face region
  childName, rawKey               // R2 key of THEIR raw upload
  jobId                           // BullMQ job id, for status lookup
}
```

**What writes to it, in order** (all in [`routes/sessions.ts`](../apps/api/src/routes/sessions.ts)
unless noted):

1. `POST /api/sessions` — creates one `Session` row + one `Character` row per slot.
2. `POST .../upload-url` — reads the `Character` row (just to check it exists), doesn't write.
3. `POST .../upload-confirm` — writes `rawKey` onto the `Character` row. Once every
   character in the session has a `rawKey` (`prisma.character.count({rawKey: null})`
   hits 0), flips `Session.status` to `"uploaded"` and enqueues the BullMQ job.
4. **`worker.ts`** (not a route — the BullMQ consumer) flips `status` to `"processing"`
   at job start, then to `"done"` + sets `previewKey` at the end, or `"failed"` on any
   stage error (`runStep`'s catch block).

**What reads from it:** `GET /api/sessions/:id` (full session+characters dump),
`GET .../pages` (reads `Session.storyId` to know the book, then checks R2 — not
Postgres — for whether each page exists).

Postgres **never stores image bytes** — `rawKey`/`previewKey` are just R2 key strings.
If you dropped the whole `Session`/`Character` tables and rebuilt from R2 object keys
alone you'd lose almost nothing except `childName` and `status`.

---

## 3. R2 — every image byte, in and out

**File:** [`src/storage.ts`](../apps/api/src/storage.ts) — the *only* file that constructs
an `S3Client`. Everything else goes through its five exports.

```
r2 = new S3Client({ endpoint: https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com, ... })

rawObjectKey(sessionId, characterId, contentType) → "sessions/<id>/characters/<charId>/raw.<ext>"
createUploadUrl(key, contentType)   → presigned PUT URL (60s TTL)     — browser uploads directly
createDownloadUrl(key)              → presigned GET URL (300s/3600s) — browser downloads directly
putObject(key, buffer, contentType) → server-side write               — worker only
objectExists(key)                   → HEAD request                    — "is this page already rendered"
getObjectBuffer(key)                → server-side read                — currently unused by the hot path
```

**The key design point: photo bytes never pass through the Node process.**

- Upload: `upload-url` route hands the browser a *presigned* PUT URL. The browser
  PUTs the raw photo straight to Cloudflare. The API only ever learns the *key*
  (`upload-confirm` records `objectKey` — it trusts the browser's word that the PUT
  succeeded, doesn't re-fetch to verify).
- Render input: `worker.ts` never downloads the photo either — it calls
  `createDownloadUrl(rawKey)` and hands that *URL* to the pipeline, which hands it
  straight to Replicate (`swap_image: photoUri` in `stages/swap.ts`). Replicate's
  servers fetch it, not this process.
- Render output: `worker.ts`'s `processJob` calls `putObject(key, finished, "image/png")`
  after each page renders — that one *is* server-side, since the finished PNG comes
  back from Replicate to this process first (`personalizePage` returns a `Buffer`).
- Download: `GET .../pages` returns a presigned GET URL per ready page; the browser
  fetches the finished image straight from R2.

**Object key layout**, both defined once so upload and render agree:
- Raw photo: `sessions/<sessionId>/characters/<characterId>/raw.<ext>` (`rawObjectKey`, storage.ts)
- Finished page: `pageObjectKey(sessionId, pageId)` in `pipeline/catalog.ts` (not shown above — check that file if you need the exact pattern)

**Why `objectExists` matters for cost:** `worker.ts:84` — `if (await objectExists(key)) return;`
skips re-rendering (and re-paying for) any page that's already in R2. This is what
makes retries and a preview→full sequence not double-pay.

CORS: R2 needs a bucket-level CORS policy allowing the browser's origin to PUT/GET
directly (Cloudflare dashboard config, not code) — only matters for `homepage`
talking to the real API through an actual browser; every other R2 interaction so far
has been server-to-server and isn't subject to CORS at all.

---

## 4. Redis — two unrelated jobs sharing one connection factory

**File:** [`src/redis.ts`](../apps/api/src/redis.ts) — `createRedisConnection()` is the
only place `new Redis(...)` gets called. Everything else imports this. It attaches an
`error` listener so a transient network blip doesn't crash the whole process
(ioredis rethrows unlistened `error` events as uncaught exceptions otherwise).

### 4a. Job queue (BullMQ)

**File:** [`src/queue.ts`](../apps/api/src/queue.ts)

- `getPipelineQueue()` — a lazy singleton `Queue<PipelineJobData>` named `"pipeline"`.
- `PipelineJobData = { sessionId, mode: "preview" | "full" }`.
- **Producer:** `routes/sessions.ts` — `upload-confirm` (once every character has
  uploaded) and `render-full` both call `.add("process", {...})`.
- **Consumer:** [`src/worker.ts`](../apps/api/src/worker.ts) — `startPipelineWorker()`
  creates a BullMQ `Worker` on the same `"pipeline"` queue name, running `processJob`.
  **Two ways to boot it, as of 2026-07-23:**
  - `src/index.ts` (`npm run dev`/`npm start`) — starts it **in the same Node process
    as the API**, only if `REDIS_URL` is set. Kept for low-friction local dev.
  - `src/worker-process.ts` (`npm run worker`), paired with `src/server.ts`
    (`npm run server`) for the API alone — **two separate OS processes**. This is the
    recommended way to run it for anything real: the worker's per-job work (`sharp`
    image ops, TF.js face detection, base64 encode/decode of multi-MB buffers) is
    synchronous CPU-bound JS that blocks whichever event loop it runs on. In the
    combined process that work could stall the API's ability to accept connections,
    serve `/health`, or flush an SSE event on time; in split processes it only ever
    blocks itself. The two processes never share memory — they coordinate purely
    through Postgres, R2, and the BullMQ queue, exactly as they would across separate
    machines in a real deployment (e.g. separate Railway/Render services).
- Concurrency: `WORKER_CONCURRENCY` env (default 1, how many jobs at once) is a
  different knob from `PAGE_CONCURRENCY` (default 3, how many pages *within one job*
  render at once) — see `worker.ts:18`.

### 4b. Pub/sub for live SSE progress

**File:** [`src/status-events.ts`](../apps/api/src/status-events.ts)

This is a *second, independent* use of Redis — nothing to do with BullMQ. Every
`runStep` call in `worker.ts` calls `publishStatus(sessionId, event)`, which does
`redis.publish("session:<id>", JSON.stringify(event))`.

On the read side, **one shared, long-lived Redis connection** pattern-subscribes to
`session:*` once, and fans out messages to in-process listeners via a plain Node
`EventEmitter` keyed by `sessionId`. The `GET .../status` SSE route just calls
`subscribeStatus(id, cb)` to attach a listener — no new Redis connection per browser
tab. (This replaced a per-request-connection design that tripped Upstash's connection
limit under a browser reconnect storm — see the comment block at
`status-events.ts:27-41` for the full incident.)

So: **BullMQ and SSE progress are two separate Redis usages that happen to share the
same Upstash instance and the same connection-factory function**, nothing more.

Without `REDIS_URL`: the worker never starts (`index.ts`), `upload-confirm` records
the upload but skips enqueueing (logs a warning), and `/status` returns 503.

---

## 5. Replicate — the actual AI calls, and where they originate

**File:** [`src/pipeline/replicate.ts`](../apps/api/src/pipeline/replicate.ts) — the
*only* file that constructs a Replicate HTTP request. Exports two functions:

- `runReplicate(path, body, noFaceRetries=0)` — POSTs to
  `https://api.replicate.com/v1/<path>` with `Prefer: wait`, polls if it doesn't
  return synchronously (cold start), retries the whole thing if the model itself
  reports `"No face found"` in its logs (a false-negative from the model's own face
  detector, not an HTTP error). Also proactively rate-limits prediction *starts* to
  `REPLICATE_RATE_LIMIT_PER_MIN` (default 6/min) — this exists because
  `PAGE_CONCURRENCY=3` × 3 stages can otherwise fire 9 calls in a few seconds and blow
  the account's rate limit.
- `fetchToBuffer(url)` — downloads a Replicate output URL to a `Buffer`.

**Every network call to Replicate goes through `runReplicate`.** Three call sites,
one per stage that needs a hosted model:

| Stage | File | Calls `runReplicate` with |
|---|---|---|
| 1. repaint | [`pipeline/stages/repaint.ts`](../apps/api/src/pipeline/stages/repaint.ts) | `models/google/nano-banana/predictions` (or `nano-banana-2-lite`) |
| 2. swap | [`pipeline/stages/swap.ts`](../apps/api/src/pipeline/stages/swap.ts), inside `swapViaReplicate` | `predictions` with a pinned `version` hash (the swap model — see §6) |
| 3. restore | [`pipeline/stages/restore.ts`](../apps/api/src/pipeline/stages/restore.ts) | `predictions` with a pinned CodeFormer `version` hash |

Stages 4 (`heal.ts`) and 5 (`eyes.ts`) are **local/free** — no Replicate call at all.

**Full call chain from an HTTP request to a Replicate prediction:**

```
worker.ts processJob
  → mapWithConcurrency(pages, PAGE_CONCURRENCY, ...)
      → personalizePage(page, characters)          [pipeline/personalize.ts]
          → personalizeBuffer(templateBuf, photoUrl)
              → repaintScene(...)   → runReplicate(...)   [repaint.ts]
              → swapIdentity(...)   → swapViaReplicate → runReplicate(...)   [swap.ts]
              → restoreFace(...)    → runReplicate(...)   [restore.ts]
              → healSwapArtifacts(...)     [local, no network]
              → restoreEyeRegion(...)      [local, no network]
```

`personalize.ts` is the single orchestration point (`personalizeBuffer`, called by
both `personalizePage` for production/homepage and directly by the CLI in `demo/`) —
whatever order/skip logic you want for the 5 stages, this is the one file to change.

---

## 5a. Optional: each stage as its own queue (`STAGE_EXECUTION=queued`)

By default (`STAGE_EXECUTION=direct`, unset), `personalizeBuffer` calls all 5 stage
functions directly, in-process, exactly as shown above — this is what the CLI and
`homepage_local` always do, and what `worker.ts` does unless you opt in.

Set `STAGE_EXECUTION=queued` in `apps/api/.env` (production `worker.ts`/
`worker-process.ts` only) to instead run each stage as its own BullMQ job on its own
queue, consumed by a **dedicated process per stage**:

```
worker.ts / worker-process.ts (orchestrator — crop/detect/compose + SSE, unchanged)
  → personalizeBuffer(...), via queueStageRunner [pipeline/queueStageRunner.ts]
      repaint: PUT input → R2, enqueue "stage-repaint",  await job, GET output ← stage-worker.ts (STAGE=repaint)
      swap:    PUT input → R2, enqueue "stage-swap",     await job, GET output ← stage-worker.ts (STAGE=swap)
      restore: PUT input → R2, enqueue "stage-restore",  await job, GET output ← stage-worker.ts (STAGE=restore)
      heal:    PUT input → R2, enqueue "stage-heal",     await job, GET output ← stage-worker.ts (STAGE=heal)
      eyes:    PUT input+repainted → R2, enqueue "stage-eyes", await, GET output ← stage-worker.ts (STAGE=eyes)
```

**Why:** each stage-worker instance only ever runs ONE stage, so it never cold-starts
switching between kinds of work — `heal`/`eyes`'s TF.js face-detector model loads once
at that process's boot and stays resident for every job it ever handles. It also means
a slow/CPU-heavy stage for one page can't stall a different stage's event loop, since
they're different OS processes entirely (same reasoning as the server/worker split in
§4a). And each stage can be scaled independently — e.g. run 2 `swap` instances if
Replicate latency is the bottleneck, without touching `heal`/`eyes`.

**Run it:** `npm run stage:repaint`, `npm run stage:swap`, `npm run stage:restore`,
`npm run stage:heal`, `npm run stage:eyes` (each is `STAGE=<name> tsx
src/stage-worker.ts` via `cross-env`) — five separate processes, one per stage,
alongside `npm run server` + `npm run worker`. `STAGE_CONCURRENCY` (default 3) controls
how many jobs one instance pulls at once. **All five must be running before you flip
`STAGE_EXECUTION=queued`, or a render enqueues its first stage job and hangs forever**
waiting for a consumer that doesn't exist.

**How data crosses the process boundary:** images never go through Redis/BullMQ job
payloads (would bloat every job and stress a metered Redis plan) — each stage PUTs its
input to a fresh scratch R2 key (`scratch/<stage>/...`) and the next stage GETs it.
Verified 2026-07-23: enqueued a real job on a live `stage-heal` queue from a standalone
script, confirmed the independently-running `heal` stage-worker picked it up, downloaded
from R2, ran `healSwapArtifacts`, uploaded a valid PNG back — full round trip, and a
second job right after didn't re-pay the TF.js load cost (only logged once, at boot).

**Known follow-up, not yet done:** scratch objects are never explicitly deleted —
precisely deleting them (only once nothing downstream still needs them, across every
character crop on a page) is easy to get wrong in a way that deletes something still in
flight. Set an R2 lifecycle rule expiring the `scratch/` prefix after ~1 day
(Cloudflare dashboard, not code) instead — same category of follow-up as the R2 CORS
policy in §5's setup notes.

---

## 6. Changing the swap model — exact location

**File:** [`apps/api/src/pipeline/stages/swap.ts`](../apps/api/src/pipeline/stages/swap.ts)

### To change *which hosted Replicate model* runs the swap:

Line 40:
```ts
const FACE_SWAP_VERSION = "d766886cf43ea2e9821703c392e3d403d2311eb8d013feef924655f9b7e2971d";
```
This is a **pinned Replicate model version hash**, not a name — the version-based
`/predictions` endpoint requires a specific hash, and pinning stops the owner's model
updates from silently changing behavior. To switch models:

1. Find the new model's version hash on Replicate (its model page → API tab).
2. Replace the hash on line 40. **Check the input contract matches** —
   `swapViaReplicate` (line 107-116) sends `{ input_image: dataUri(targetBuf), swap_image: photoUri }`;
   if the new model expects different input field names, update that call too.
3. Two known-good hashes are already in the comments above line 40 if you ever need
   to flip back:
   - `ddvinh1/face-swap-gpu` → `d766886c...` (current: GPU, ~1s warm/22s cold, ~$0.0002/call)
   - `codeplugtech/face-swap` → `278a81e7...` (CPU, ~55-90s, ~$0.006/call — the hash prefix is
     in [`swap-self-hosting` memory], check `git log -- src/pipeline/stages/swap.ts` for the
     full hash if reusing it)

### To change *which backend* runs the swap (hosted vs. self-hosted), not the model:

`env.SWAP_BACKEND` (set in `apps/api/.env`), read in [`env.ts`](../apps/api/src/env.ts):
- `replicate` (default) — always hosted, via `FACE_SWAP_VERSION` above.
- `local` — always the self-hosted service at `SWAP_LOCAL_URL` (default
  `http://127.0.0.1:5175`), errors if it's not running. Service lives in
  `services/faceswap/` (FastAPI, off by default, not auto-started anywhere).
- `auto` — tries local first, falls back to hosted on any local failure.

The branch is in `swapIdentity` at the bottom of `swap.ts` (line 142-162). Note:
**both backends run the same underlying InsightFace `inswapper` model** — switching
backend is a speed/cost lever, not a licensing one (inswapper is non-commercial/
research licensed either way; see `swap-self-hosting` project memory for the full
entanglement with the licensing risk).

Restore's model (CodeFormer) is pinned the same way in
[`stages/restore.ts:6`](../apps/api/src/pipeline/stages/restore.ts) —
`CODEFORMER_VERSION` — if that ever needs changing, same pattern applies.

Repaint's model is chosen by the `repaintModel` option in `PersonalizeOptions`
(`"nano-banana"` default, `"nano-banana-2-lite"` also wired up but **verified
unusable** — it discarded the template scene once, don't re-try it as a cost lever).

---

## 7. Whole-request trace, start to finish

```
Browser (homepage, :5174)
  │
  ├─ POST /api/sessions ─────────────────────► Postgres: create Session + Character rows
  │
  ├─ POST .../upload-url ─────────────────────► R2: presigned PUT URL (no DB/pipeline touch)
  ├─ PUT photo bytes ─────────────────────────► R2 directly (browser→R2, API never sees bytes)
  ├─ POST .../upload-confirm ─────────────────► Postgres: record rawKey
  │                                              once ALL characters uploaded:
  │                                              Postgres: Session.status = "uploaded"
  │                                              Redis: BullMQ job enqueued (queue.ts)
  │
  ├─ GET .../status (SSE, stays open) ────────► Redis: subscribe to session:<id> pub/sub
  │
  │         [meanwhile, same process, worker.ts picks up the job]
  │         Postgres: Session.status = "processing"
  │         for each character: validatePhoto (local, free)
  │         for each page (up to PAGE_CONCURRENCY):
  │           skip if R2.objectExists(pageKey)          ← R2 read
  │           personalizePage() → repaint/swap/restore/heal/eyes
  │             repaint, swap(hosted), restore → Replicate (replicate.ts)  ← the ONLY
  │             heal, swap(local option) → local/no network                  network calls
  │           R2.putObject(pageKey, finishedPng)          ← R2 write
  │           Redis: publishStatus(...) after every stage  ← SSE progress
  │         Postgres: Session.status = "done", previewKey = <first page key>
  │         Redis: publishStatus({type:"done", previewUrl})
  │
  ├─ GET .../pages (polled) ──────────────────► R2: objectExists per page + presigned GET URLs
  └─ (renders finished pages) ────────────────► R2 directly (browser fetches image bytes)
```

---

## 8. Quick file index

| Concern | File |
|---|---|
| Postgres client | `src/db.ts` |
| DB schema | `prisma/schema.prisma` |
| R2 client + all storage ops | `src/storage.ts` |
| Redis connection factory | `src/redis.ts` |
| BullMQ queue (producer side helper) | `src/queue.ts` |
| BullMQ worker (consumer logic) | `src/worker.ts` |
| API-only process boot (pairs with worker-process.ts) | `src/server.ts` |
| Worker-only process boot (pairs with server.ts) | `src/worker-process.ts` |
| Per-stage queue names/job types (shared producer+consumer contract) | `src/pipeline/stageQueue.ts` |
| Per-stage queue producer (used when `STAGE_EXECUTION=queued`) | `src/pipeline/queueStageRunner.ts` |
| Per-stage queue consumer — one process per stage, see §5a | `src/stage-worker.ts` |
| Combined API+worker boot (one process, dev convenience) | `src/index.ts` |
| SSE pub/sub | `src/status-events.ts` |
| HTTP routes | `src/routes/sessions.ts` |
| Env/config | `src/env.ts` |
| Replicate HTTP client (the only one) | `src/pipeline/replicate.ts` |
| Retry/backoff for any HTTP call | `src/pipeline/retry.ts` |
| Pipeline orchestration (5 stages, in order) | `src/pipeline/personalize.ts` |
| Stage 1: repaint (nano-banana) | `src/pipeline/stages/repaint.ts` |
| Stage 2: swap (**model version here**) | `src/pipeline/stages/swap.ts` |
| Stage 3: restore (CodeFormer) | `src/pipeline/stages/restore.ts` |
| Stage 4: heal (local) | `src/pipeline/stages/heal.ts` |
| Stage 5: eyes (local) | `src/pipeline/stages/eyes.ts` |
| Page/book registry | `src/pipeline/catalog.ts` |

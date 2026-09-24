# Prototype overview

A single current document covering the whole system: what it is, how the pieces fit
together, and how to actually run it. Other docs have narrower jobs — this one is the
map. `PROJECT_PLAN.md` is a historical record of the original 3-day engagement plan;
`apps/api/README.md` is the API package's own setup/architecture reference;
`docs/DEMO_RUNBOOK.md` is the step-by-step client-demo script. Read this one first.

---

## 1. What this is

A prototype for a paid product: upload a photo of a child, and a children's-book
illustration is repainted so the drawn character becomes that child — real AI
personalization, not a template swap or a face pasted into a hole. API-only engagement
(no consumer-facing website is being built in this phase; `apps/web` is a deliberately
deferred placeholder for that).

Two reference competitors do the same category of thing: bokibooks.co.uk and
imagitime.com.

## 2. The engine — one recipe, five stages

Everything ultimately funnels through `personalizePage()` in
`apps/api/src/pipeline/personalize.ts`. Given a page of artwork and one or more
children's photos, it runs:

| # | Stage | File | Cost | What it does |
|---|-------|------|------|---------------|
| 1 | repaint | `stages/repaint.ts` | ~$0.039 | Redraws the whole illustration as this child (`google/nano-banana`) |
| 2 | swap | `stages/swap.ts` | ~$0.0002–0.006 | Pins the likeness to exactly this child (InsightFace inswapper, hosted GPU by default) |
| 3 | restore | `stages/restore.ts` | ~$0.005 | Blends the swap back into the painterly art (CodeFormer, hosted) |
| 4 | heal | `stages/heal.ts` | free | Removes small near-white swap specks, locally |
| 5 | eyes | `stages/eyes.ts` | free | Paints the repaint's eyes back over the swap's, locally (currently ON by default — see §6) |

Roughly **$0.045 per page, per character**. Wall time is currently dominated by the
`restore` stage (~26s/character, hosted) — see [swap-self-hosting notes] for why that's
a cold-start cost, not real inference time, and why self-hosting it was tried, measured
faster, and then deliberately reverted (kept hosted "for now").

**Solo pages** (one drawn character) repaint the whole page in one call — no detection,
no cropping. **Multi-character pages** crop each drawn character generously, run the
full solo recipe on each crop independently, then feather the results back onto the
original page (`compose.ts`). Faces map to character slots **left to right** unless a
page overrides that with `slots` in `catalog.ts` — see the upload-order gotcha in §7.

`catalog.ts` is the one registry of pages (`PAGES`) and books (`BOOKS`) — add a page
there, nowhere else.

## 3. Four ways to run it

The same engine, four different front doors. Pick based on what you're trying to prove
or do:

| Surface | Command | Port | Needs | Use it for |
|---|---|---|---|---|
| **Production API + worker (combined)** | `npm run dev` | :3001 | Full `.env` | Low-friction local dev — both in one process |
| **Production API + worker (split)** | `npm run server` + `npm run worker` (2 processes) | :3001 | Full `.env` | **Recommended for anything real** — see §4a |
| **`homepage`** | `npm run homepage` | :5174 | Full `.env` + the API running (`dev`, or `server`+`worker`) | Proving the real end-to-end product works, through a browser |
| **`homepage_local`** | `npm run homepage:local` | :5179 | Just `REPLICATE_API_TOKEN` | Fast pipeline iteration, or a demo immune to infra problems |
| **CLI** | `npm run personalize -- photo.jpg` | — | Just `REPLICATE_API_TOKEN` | Scripted/batch runs, `--detect-only` free preflight, `--debug` intermediate frames |

`homepage` and `homepage_local` are the **same UI** talking to **different backends** —
literally the same `index.html` design, forked when `homepage` was rewired to be a real
client of the production API instead of calling the pipeline directly. `homepage_local`
is what `homepage` used to be, kept side by side rather than deleted, because "prove the
real product works" and "iterate on the pipeline without needing Postgres/Redis/R2
running" are different jobs.

All four call the identical `personalizePage()` — what you see from any of them is real
model output, not a mock.

## 4a. API and worker are now two separate processes

`src/index.ts` (what `npm run dev`/`npm start` run) still boots the Fastify API and the
BullMQ worker in one Node process — kept as-is for low-friction local dev, since it's
what's been verified against so far. But that combined mode has a real cost: the
worker's per-job work — `sharp` image ops, TF.js face detection (`faceDetect.ts`), and
base64 encode/decode of multi-MB page buffers (`dataUri.ts`, the local swap path) — is
synchronous, CPU-bound JS. Sharing an event loop with the HTTP server means a page
mid-render can stall this process's ability to accept new connections, answer
`/health`, or flush an SSE event on time. The two are logically independent already
(they only ever talk through Postgres/R2/the BullMQ queue, never shared memory), so the
fix is running them as two OS processes instead of splitting the code:

- `src/server.ts` (`npm run server`) — Fastify API only. No BullMQ worker attached.
- `src/worker-process.ts` (`npm run worker`) — BullMQ worker only. No HTTP server.

Both read the same `.env`. Run them in two terminals (or two `.claude/launch.json`
entries: `api-server` + `api-worker`) instead of `npm run dev` for anything where the
API's responsiveness matters — which is the recommended way to run this for a real
demo or in production. Verified 2026-07-23: booted each independently — `server.ts`
served `/health` with no worker in the process at all; `worker-process.ts` picked up
the BullMQ connection and warmed the face detector with zero Fastify/HTTP code loaded.

## 4b. How the real flow actually works (`homepage` → production API → R2/Postgres/Redis)

This is the part worth understanding in detail, since it's new this session and has
more moving parts than the other three surfaces.

```
Browser (:5174)                 Production API (:3001)              Worker (separate process — §4a)
     |                                  |                                      |
     |-- POST /api/sessions ----------->|  creates Session + Character rows    |
     |<-- sessionId, characterIds ------|  in Postgres                         |
     |                                  |                                      |
     |-- POST .../upload-url ---------->|  presigned R2 PUT URL                |
     |<-- uploadUrl, objectKey ---------|                                      |
     |                                  |                                      |
     |-- PUT photo bytes ---------------|-----------------> R2 (direct,        |
     |                                  |                    browser-to-R2,    |
     |                                  |                    bypasses the API) |
     |                                  |                                      |
     |-- POST .../upload-confirm ------>|  records rawKey; once EVERY          |
     |                                  |  character has uploaded, enqueues    |
     |<-- allUploaded: true ------------|  a BullMQ job ------------------------>|
     |                                  |                                      |  dequeues job
     |-- GET .../status (SSE) --------->|  subscribes to this session's        |  validates each
     |<== live status/stage events =====|  Redis pub/sub channel <==============|  photo (free,
     |                                  |                                      |  local)
     |-- GET .../pages (poll) --------->|  checks R2 for each expected --------|  renders each
     |<-- ready: true/false, url -------|  page (objectExists)                 |  page, PUTs
     |                                  |                                      |  finished PNG
     |                                  |                                      |  to R2
```

**Why the client polls `/pages` instead of trusting the SSE `done` event to know when
it's finished:** the SSE route is built for one job per session and closes the stream
after that job's first `done`/`error`. But uploading the last photo auto-enqueues a
`"preview"` job, and `homepage` also wants the whole book — it passes `mode: "full"` on
upload-confirm so **one** job renders every page (this used to be a second, sequential
job; see §6). Even with one job, `GET .../pages` (which pages actually exist in R2) is
the honest source of truth for "is this done," and that's what the client checks.

**Why photos go browser → R2 directly, not through the API:** the API only ever hands
out a short-lived *presigned* PUT URL (`createUploadUrl` in `storage.ts`); the actual
bytes never pass through the Node process. Same pattern for reading finished pages back
(`createDownloadUrl`, GET). The bucket needs its own CORS policy allowing the browser's
origin to PUT/GET directly — this is Cloudflare-side config, not application code, and
is easy to forget since every *other* R2 interaction in this project so far had been
server-to-server (not subject to browser CORS at all) until `homepage` started doing
this for real.

**What actually renders a page:** `worker.ts`'s `processJob`, a BullMQ consumer running
in the *same process* as the API server (started by `src/index.ts` when `REDIS_URL` is
set). It validates every character's photo (local, free), then renders every page for
the job's mode up to `PAGE_CONCURRENCY` (default 3) at a time, skipping any page that
already exists in R2 — so retries and a preview-then-full sequence never pay twice for
the same page.

## 5. Setting it up from nothing

```bash
git clone <repo>
cd apps/api
cp .env.example .env
npm install
```

Fill in `.env`:
- **Just running the pipeline (`homepage_local`, CLI, `--detect-only`):** only
  `REPLICATE_API_TOKEN` is required.
- **Running the real product (`npm run dev`, `homepage`):** also needs `DATABASE_URL`
  (Postgres — Neon works), `R2_ACCOUNT_ID`/`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`/
  `R2_BUCKET_NAME` (Cloudflare R2), `REDIS_URL` (must be `rediss://` — TLS; Upstash
  rejects plain `redis://`). Then: `npx prisma migrate deploy` once, and set the R2
  bucket's CORS policy (see §4) if you'll be testing `homepage` through an actual
  browser rather than server-to-server.
- **`CORS_ORIGIN`** is comma-separated (`http://localhost:3000,http://localhost:5174`)
  — add whatever origin is calling the API. `homepage`'s origin (`:5174` by default)
  needs to be in this list or its SSE connection will fail CORS with no useful error in
  the browser (see the bug writeup in `apps/api/README.md`'s "Known state").

Without the Day-1 keys (`DATABASE_URL`, `R2_*`) the server still boots — routes that
need them 500 clearly instead of crashing. Without `REDIS_URL` the worker doesn't
start, `upload-confirm` skips enqueueing (logged), and `/status` returns 503.

## 6. What changed this session (2026-07-23)

Two large pieces of work, done together:

**`homepage` became a real client of the production API**, not a separate in-process
pipeline call. `homepage_local` was created as a restored copy of the old design, so
nothing was lost — both exist side by side now (§3). This surfaced and fixed four real
bugs that only show up under actual cross-origin browser use (full writeup in
`apps/api/README.md`'s "Known state"):

1. The SSE `/status` route was missing its CORS header (bypassed `@fastify/cors` by
   writing the raw response directly) — the actual root cause of live progress text
   never updating in the browser.
2. One Redis connection per SSE subscriber, no pooling — a browser reconnect storm
   could trip Upstash's connection limits, which looked exactly like a Redis outage.
   Now one shared, long-lived pub/sub connection fans out in-process.
3. An unhandled promise rejection in the subscribe path could crash the whole API+worker
   process — the actual cause of renders that appeared to "jump straight from queued to
   done" with no visible progress.
4. A double-job (preview job + separately-requested full job) architecture made
   solo-mode renders take roughly twice as long as necessary; `mode: "full"` on
   upload-confirm collapses it to one job.

**Eye handling (`eyeFix`) was extensively iterated on and ended up unchanged from where
it started** — currently `true` (eyes.ts runs) after being flipped to `false`, tested,
and flipped back per direct instruction mid-session. A `--no-eyes` CLI flag was added
for one-off comparisons without touching the default. The repaint prompt was hardened
several times (skin tone, eye-colour containment, eyebrow phrasing, hair texture) —
see `pipeline-lessons` history for what's been tried and what's failed repeatedly
(prompt text has never successfully controlled child eye SIZE specifically, across five
attempts; that's a model-behavior ceiling, not something to keep re-attempting via
wording).

The swap model backend was also toggled between the hosted GPU model
(`ddvinh1/face-swap-gpu`) and the older hosted CPU model (`codeplugtech/face-swap`)
multiple times on direct request — currently on the GPU model. Both version hashes are
recorded in `stages/swap.ts`'s comments if this needs to change again.

## 7. Known risks and rough edges

In priority order — see `apps/api/README.md` for the full detail on each:

1. **Licensing blocks selling, not building.** The swap model (InsightFace inswapper)
   is non-commercial/research licensed. A commercial licence is needed before this can
   be sold, regardless of hosted vs. self-hosted.
2. **Single-character page art (`astronaut`, `plane`, `workshop`) is competitor
   screenshots**, not shippable illustration — fine for demonstrating the engine.
3. **Non-determinism is undersampled.** The same photo and page will not reproduce a
   previous result; anything claimed "fixed" or "reliable" needs N≥5 runs, not one good
   render, before it's trusted.
4. **Upload order is a fixed convention, not a UI label.** Child's photo always first
   (`child_1`), adult second (`child_2`), regardless of which side a page draws either
   character on — enforced in code via `catalog.ts`'s `slots` field, because a prior
   attempt to fix this with clearer UI copy alone did not work (users repeat habits, not
   read labels).
5. **Hair length/texture and eye geometry resist prompt control specifically for child
   characters** — documented dead ends, don't re-attempt via prompt wording without a
   genuinely new angle; see `pipeline-lessons` for the full attempt history before
   spending more on this.

## 8. File map

```
apps/api/
  src/
    app.ts                    Fastify app definition (routes, cors, swagger)
    index.ts                  combined dev boot: API + worker, one process
    server.ts                 API-ONLY boot — pairs with worker-process.ts, see §4a
    worker-process.ts         WORKER-ONLY boot — pairs with server.ts, see §4a
    worker.ts                 BullMQ consumer — the thing that actually renders pages
    routes/sessions.ts       session/upload/render/status/pages endpoints
    storage.ts                R2 client (presigned PUT/GET, put/get/exists)
    status-events.ts          Redis pub/sub for live SSE progress
    queue.ts, redis.ts, db.ts  BullMQ / ioredis / Prisma wiring
    pipeline/                 the engine — see §2
  homepage/                  real end-to-end product UI (thin client of the API)
  homepage_local/            pipeline-only UI (in-process, no infra needed)
  demo/                      CLI (`personalize.mts`), benchmark, QA fixtures
  prisma/schema.prisma       Session + Character models
docs/
  PROTOTYPE_OVERVIEW.md      this file
  DEMO_RUNBOOK.md            step-by-step client-demo script
  DEMO_PLAN.md               superseded, kept as a historical record
PROJECT_PLAN.md              historical record of the original engagement plan
services/faceswap/           optional self-hosted swap backend (off by default)
```

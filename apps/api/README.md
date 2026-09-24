# apps/api — Fastify backend + the personalization engine

TypeScript service that owns multi-character sessions, presigned R2 uploads, the BullMQ
pipeline worker, the SSE status stream, the OpenAPI docs — and the image engine itself.

> This file covers the personalization engine specifically. The same service also has a
> cart/checkout/print-dispatch layer (`src/routes/checkout.ts`, `src/fulfillment.ts`,
> `src/print/`, `src/email/`) — see
> **[../../docs/CART_CHECKOUT_SETUP.md](../../docs/CART_CHECKOUT_SETUP.md)** for that.

## Setup

```bash
cd apps/api
cp .env.example .env      # fill in the keys below
npm install
npx prisma migrate deploy
npm run dev                # http://localhost:3001, docs at /docs
```

Required: `DATABASE_URL`, `R2_*` (the upload loop); `REDIS_URL` (must be `rediss://`, TLS —
Upstash rejects plain `redis://`) and `REPLICATE_API_TOKEN` (the engine — face detection is
local and free; the repaint, swap and restore calls are the paid steps).

Without a given key set the server still boots, so `/docs` stays browsable; the specific
routes and steps that need it fail clearly instead (a 500, a 503 on `/status`, or a skipped
enqueue with a logged warning) rather than crashing the process.

## How the engine works

One recipe, five stages, in `src/pipeline/`. Every stage exists because something specific
failed without it — each stage file documents what was tried and rejected, which is worth
reading before changing any of them.

| # | Stage | File | Cost | What it does |
|---|-------|------|------|--------------|
| 1 | repaint | `stages/repaint.ts` | ~$0.039 | Redraws the whole illustration as this child (`google/nano-banana`) |
| 2 | swap | `stages/swap.ts` | ~$0.006 | Pins the likeness to exactly this child (InsightFace inswapper) |
| 3 | restore | `stages/restore.ts` | small | Blends the swap back into the painterly art (CodeFormer) |
| 4 | heal | `stages/heal.ts` | free | Removes small near-white swap specks, locally |
| 5 | eyes | `stages/eyes.ts` | free | Paints the repaint's eyes back over the swap's, locally |

Roughly **$0.045 per page, per character**, and ~90–170s wall time.

Cost and latency live in *different* stages, which is easy to get backwards. Measured from the
Replicate account's real prediction history: the **repaint dominates cost** ($0.039 flat) but
is fast at ~9–12s; the **swap dominates latency** at ~55–90s. Don't optimize the repaint for
speed or the swap for cost.

### The swap's 60 seconds are cold start, not inference

Worth understanding before optimizing anything: the hosted swap bills ~$0.006 at Replicate's
CPU rate of $0.0001/s — which is **~60 seconds of billed CPU** for a model whose real
inference is under a second. It is not queue wait. Every call reloads the buffalo_l analysis
pack plus `inswapper_128.onnx` (several hundred MB) from disk, runs one image, and discards it.

So the stage is self-hostable at a large discount. `services/faceswap` runs the same model
with the weights resident:

| | hosted | self-hosted (CPU) |
|---|---|---|
| swap stage | 55–90s | ~3.5s (measured) |
| **page total** | **90–170s** | **~15–25s** |

Switch with `SWAP_BACKEND=local` (default `replicate`, so a checkout without the service
running is unaffected). It needs weights that are not in this repo — see
[services/faceswap/README.md](../../services/faceswap/README.md). Measure it with
`npm run bench:swap`.

This is what makes the *full book* viable rather than just faster: 24 pages is
`24 × ~120s ÷ 3 concurrent ≈ 16 minutes` hosted, versus well under a minute self-hosted with
room to raise concurrency.

**It does not change the licensing position** — self-hosting inswapper is still a licensed use
of a non-commercial model, arguably more clearly so. See "Known state" below.

**Why repaint-then-swap.** The repaint SEES the photograph, so one generic prompt personalizes
any child with no per-child hair/skin text, and because it redraws the artwork cohesively there
are no seams or halos. The swap alone is not enough — measured, it changed only ~0.43% of a
page, leaving the wrong hair, an unwanted headband and pale hands. It is the identity stage,
not the engine.

**Two approaches were tried and rejected.** Masked inpainting (FLUX Fill) to preserve the
illustrator's exact pixels left visible seams and a bright halo around the hair on
open-background pages; the client rejected it outright. Before that, generating a portrait and
compositing it in fought pose and identity drift and needed per-template hand-calibration for
every page. Neither should be revisited — see [PROJECT_PLAN.md](../../PROJECT_PLAN.md) for the
full history.

### Page routing

`personalize.ts` is the only entry point. It routes on how many characters a page draws:

- **Solo pages** repaint the whole page in one call. No detection, no cropping, no
  compositing — the simplest path and the most proven.
- **Multi-character pages** give each drawn character their own generous crop, personalize each
  one individually against their own photo (so every child gets the solo recipe), then feather
  the finished crops back onto the original page. The crop geometry and the blending are in
  `compose.ts` and both took real measurement to get right.

Faces map to character slots **left to right** unless a page overrides that with `slots`. A
drawn character with no child mapped to them is left exactly as the illustrator drew them.

### File map

```
src/pipeline/
  catalog.ts      the ONE registry of pages and books — add a page here, nowhere else
  personalize.ts  the engine entry point; routes solo vs. multi-character
  compose.ts      multi-character crop geometry + feathered compositing
  faceDetect.ts   local blazeface detection (free)
  validate.ts     photo validation for uploads
  replicate.ts    Replicate client (prediction polling, "No face found" retries)
  retry.ts        HTTP retry policy (network, 5xx, 429)
  pool.ts         bounded-concurrency map
  dataUri.ts      Buffer → data URI
  types.ts        shared types
  stages/         the five stages above, one file each
```

`compose.ts` has an important split: `characterCrop` decides **what the models receive** and any
change to it needs full repaint+swap re-verification, while `cropOverlay` only decides **how the
finished result is blended back** and cannot affect reliability. Fix cosmetic seam problems in
`cropOverlay`, never in `characterCrop`.

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | liveness check |
| GET | `/docs` | Swagger UI (OpenAPI) |
| POST | `/api/sessions` | create a session with one or more characters (`storyId`, `characters: [{slot, childName}]`). Rate-limited per IP (429). Sets `expiresAt` (see "Session expiry") |
| GET | `/api/sessions/:id` | inspect a session and its characters |
| POST | `/api/sessions/:id/characters/:characterId/upload-url` | presigned R2 PUT URL for that character's photo |
| POST | `/api/sessions/:id/characters/:characterId/upload-confirm` | record the upload; once *every* character has uploaded, enqueues the pipeline — mode `"preview"` (default) or `"full"` if the body sets `mode: "full"`. **400** unless `objectKey` is exactly the key `upload-url` issued for this session+character *and* the object exists in R2. Slides the session expiry forward |
| POST | `/api/sessions/:id/render-full` | enqueues the rest of the book (mode `"full"`); pages already rendered for the preview are reused, not re-paid for. Slides the session expiry forward |
| GET | `/api/sessions/:id/pages` | every page in the book with render status and a signed URL if ready — the reliable source of truth for "is this done," independent of the SSE stream |
| GET | `/api/account/my-data` | logged-in customer: per order item, photo status (`stored`/`deleted`) and scheduled deletion dates (see "GDPR photo deletion") |
| DELETE | `/api/account/my-data` | logged-in customer: body must be exactly `{ "confirm": "DELETE" }`. Deletes all their photos and book files now, anonymises their orders, deletes the account, clears the cookie. **409** while a paid order isn't dispatched yet. Rate-limited per IP |
| GET | `/api/sessions/:id/status` | **SSE** — live progress per character/step; `render`-step events also carry `page` and `stage` (`repaint`/`swap`/`restore`/`heal`/`eyes`) so a client can show per-page, per-stage text, not just one line for the whole batch — plus the final `done`/`error` event |

**`mode: "full"` on upload-confirm exists for a reason worth knowing:** the default flow is
preview-then-render-full, which is *two* sequential BullMQ jobs (worker concurrency defaults to
1) — fine for the real product (preview now, buy later), but if a caller wants the whole book
immediately anyway, two sequential jobs take roughly twice as long as one job rendering every
page concurrently. Pass `mode: "full"` on upload-confirm to skip straight to the single-job path.

**The SSE `done`/`error` event is per-job, not per-session** — if a caller enqueues more than one
job for the same session (the preview-then-full sequence does exactly this by default), the
route closes the stream after the *first* job's `done`/`error`, even if another job for that
same session is still running. A client that cares about "is everything actually finished" should
treat `GET .../pages` (every expected page's `ready` flag) as the source of truth, not the SSE
`done` event — `homepage/`'s client code does this for exactly that reason.

## Production job flow

One BullMQ job per session, mode `"preview"` (only pages flagged `preview: true` in
`catalog.ts`) or `"full"` (the whole book, reusing anything already rendered). Preview mode is
the main cost lever — most visitors never buy, so we don't pay to render their whole book.

Per **character**, in parallel: `validate` (exactly one face, blazeface confidence ≥ 0.9, and
at least 200×200 — local, free, and it confirms the photo is usable before anything is spent).
Once every character is ready, one `render` step renders every page for that mode, up to
`PAGE_CONCURRENCY` (default 3) pages in flight. Each page may itself issue the full stage chain
per drawn character.

A page already in R2, from a prior preview or a retried attempt, is skipped rather than
re-paid for. Any step failure sets `status = failed` and emits an SSE `error` event with a
user-facing message; the full error is always logged server-side, even when the SSE message is
generic.

Pipeline (render) jobs use `attempts: 1` — no automatic BullMQ retry, so a failure surfaces immediately. Retries
happen at the HTTP level inside a call (`retry.ts`) and for the swap model's own false-negative
face detection (`replicate.ts`'s `noFaceRetries`).

## Fulfilment queue (paid orders)

The Stripe webhook (`payment_intent.succeeded`) only marks the order `paid` and **enqueues** a job on the
`fulfillment` queue. `jobId` is the order id, so Stripe redeliveries dedupe. `src/fulfillmentWorker.ts`
consumes it, started alongside the pipeline worker in both run modes (`npm run dev`, or `npm run worker`).
If the enqueue fails, the webhook answers 5xx so Stripe redelivers. Nothing is fire-and-forget any more, so a
crash can't silently lose a paid order.

5 attempts with exponential backoff (30s, 1m, 2m, 4m). Failed jobs are kept (`removeOnFail: false`) for
inspection and retry. Only the **final** failure marks the order `failed`, and never once Gelato already has
the order. Every step is idempotent, so a retry just re-runs from the top:

| Step | Skipped when |
|---|---|
| render the full book | every page in `printPageKeys` already exists in R2 (a stale *finished* render job with the same id is removed first, so a retry can't get stuck on an old failure) |
| build print PDFs | the item's `printPdfKey` is set and the object exists |
| submit to Gelato | `gelatoOrderId` is set. **Never twice:** `gelatoSubmitStartedAt` is stamped before the POST. A definite 4xx clears it (safe to retry). A timeout, 5xx or crash leaves it set, and the next attempt stops with an `UnrecoverableError` for manual reconciliation against Gelato's dashboard |
| confirmation / activation email | `confirmationEmailSentAt` / `activationEmailSentAt` is set (stamped after a successful send; Resend errors now throw instead of passing silently) |

`FULFILLMENT_CONCURRENCY` (default 2) sets how many orders are fulfilled at once.

## Abuse limits & webhook auth

- **Rate limits** (`src/rateLimit.ts`, `@fastify/rate-limit` with `global: false`). Magic-link and
  password-reset requests: per IP **and** per email. Password login: per IP and per email. `POST /api/sessions`:
  per IP. Limits are env-configurable (`RL_*` in `.env.example`). Counters don't depend on whether the account
  exists, so a 429 reveals nothing. The store is **in-memory, per process**: move to the plugin's Redis store
  before running more than one API instance. Behind a proxy, set `TRUST_PROXY=true` or every visitor shares
  the proxy's IP bucket.
- **Gelato webhook fails closed.** It requires `GELATO_WEBHOOK_SECRET` (constant-time compare against
  `x-gelato-webhook-secret`). `GELATO_WEBHOOK_ALLOW_UNSIGNED=true` is a dev-only override that is logged at
  startup. Malformed JSON returns 400. An unknown order is logged and returns 200 (so Gelato stops retrying).
- `GET /api/orders/:id` is public (the `/track` link), so it returns no email or address.

## Admin role

`Customer.role` is `"customer"` (default) or `"admin"`. `requireAdmin(request, reply)` in `src/auth/guard.ts`
answers 401 when not logged in and 403 when not an admin. It's for Milestone 4's `/admin` routes, none of
which exist yet. **No API route can grant the role**; only the CLI can:

```bash
npm run make-admin -- someone@example.com            # the customer must already exist
npm run make-admin -- someone@example.com --revoke
```

## Session expiry

Every personalization session has `expiresAt` = now + `SESSION_TTL_HOURS` (default 72) at creation. The
expiry slides forward, and `lastActivityAt` is bumped, on upload-confirm and render-full. It is the input to
GDPR deletion Pathway 1 (raw uploads deleted 24h after expiry, see below). A session on a paid order is never
"expired" for deletion, whatever `expiresAt` says. Checkout also slides the expiry, so Pathway 1 can't delete a
photo between an order being created and paid.

## GDPR photo deletion

Everything is in `src/gdpr/`. Full policy, reasoning and the inventory of where photos end up (including what we
**can't** delete: Replicate, Gelato, Stripe, the worker's repaint disk cache, `scratch/`) are in
[docs/superpowers/specs/2026-09-24-gdpr-deletion-design.md](../../docs/superpowers/specs/2026-09-24-gdpr-deletion-design.md).

| Pathway | What | When | How |
|---|---|---|---|
| P1 | raw uploads of sessions with no paid order (abandoned checkouts and cancelled orders count as unordered) | `now > expiresAt + 24h` | hourly sweep. **Rendered previews are kept.** |
| P2a | raw uploads of a delivered order's sessions | `now > deliveredAt + 24h` | hourly sweep |
| P2b | processed files: pages, preview, print PDF | `now > deliveredAt + 30 days` | hourly sweep |
| P3 | everything for the customer; orders anonymised, account deleted | immediately | `DELETE /api/account/my-data` |

- **The policy lives in one file**, `src/gdpr/schedule.ts`, used by both the sweeper and `GET /api/account/my-data`.
  A session with any order still being made, shipped, or `failed` (an admin may retry it) is **held**: nothing is
  deleted under it. `Order.deliveredAt` is stamped by the Gelato webhook the first time it reports `delivered`,
  and never moved after that.
- **`deleteSessionAssets()`** (`src/gdpr/deleteSessionAssets.ts`) is the one deletion primitive. It finds objects by
  listing the session's R2 prefixes *and* from the DB keys, deletes R2 first, re-lists to confirm, and only then
  nulls the key columns and sets `Session.rawDeletedAt`/`processedDeletedAt` in one transaction. Any failure leaves
  the markers unset, so the next run retries. It writes exactly one `DeletionAuditLog` row per call (dry runs and
  failures included), with no email, name or key in it. It refuses any stored key outside the session's own
  prefixes.
- Once a marker is set, upload-url, upload-confirm and render-full answer **410**: a new upload would never be
  swept again.
- **The sweep** (`src/gdpr/sweeper.ts`) runs on the `gdpr` BullMQ queue (`src/gdprWorker.ts`, started in both run
  modes) every `GDPR_SWEEP_INTERVAL_MINUTES` (default 60). **The first sweep runs as soon as the worker starts.**
  It finds candidates with indexed SQL, re-checks each against `schedule.ts` on fresh rows, continues past
  failures, and then fails the job (kept, `removeOnFail: false`) naming any sessions that failed.
- **Dry run by default.** Unless `GDPR_DELETION_DRY_RUN` is exactly `false`, the sweep deletes nothing and only
  writes audit rows with `dryRun=true`. Because nothing is marked, a dry run re-reports the same sessions
  **every run** (one audit row per due session per hour). Pre-existing sessions were backfilled with
  `createdAt + 72h`, so on an existing database most unordered sessions are due on the first sweep. Look at the
  dry-run rows first. `DELETE /api/account/my-data` is not automated and ignores the flag.

```bash
npm run gdpr:sweep -- --dry-run                     # one sweep now, no Redis needed, deletes nothing
npm run gdpr:sweep -- --dry-run --sessions id1,id2  # only these sessions
```

End-to-end check with seeded data under `sessions/gdpr-test-*` (commands printed by the seed):

```bash
npx tsx test/seed-gdpr-demo.mts                    # seed 5 sessions in every state
npx tsx test/seed-gdpr-demo.mts --status           # R2 objects, markers and audit rows per session
npx tsx test/seed-gdpr-demo.mts --mark-dispatched  # unblock account deletion
npx tsx test/seed-gdpr-demo.mts --clean
```

## Homepage and demo harness

**Two homepages now, same UI, different backends:**

- `homepage/` is a **thin client of the real production API** — sessions, presigned R2
  uploads, a real BullMQ job, the real worker. Needs the full stack running (`npm run dev` for
  the API+worker, plus Postgres/Redis/R2 all reachable). This is what actually proves the
  product works end to end, not just the engine.
- `homepage_local/` is the *original* design: calls `personalizePage()` directly, in-process,
  with no Postgres/Redis/BullMQ/S3 dependency at all — so a client demo can't be taken down by
  infrastructure that has nothing to do with what's being shown. Use this for a no-fuss demo or
  fast local pipeline/prompt iteration.

`demo/` (CLI + benchmark + QA images) also runs the identical engine in-process, same as
`homepage_local/`.

```bash
npm run dev                               # API + worker, :3001 (only needed for `homepage`)
npm run homepage                          # real end-to-end product, :5174
npm run homepage:local                    # pipeline only, no infra, :5179
npm run personalize -- kid.jpg            # CLI, every page
npm run personalize -- kid.jpg dad.png --page newtemp
npm run personalize -- kid.jpg dad.png --detect-only   # FREE preflight, no API calls
```

`--detect-only` runs only local detection and writes the crops that *would* be sent for
repainting. Always run it before paid work when crop geometry has changed.

See [docs/DEMO_RUNBOOK.md](../../docs/DEMO_RUNBOOK.md) for the full client-demo procedure.

Test scripts against the real API:
- `test/e2e-single.mjs <photo> [childName]` — one character, preview pages only.
- `test/e2e-multichar.mjs <storyId> <photo> <slot> <name> [...]` — N characters.
- `test/list-past-runs.mjs` — inspect previous sessions and their rendered pages.

## Known state

**Verified end-to-end through the real API:** a full multi-character session — create → upload
two different children's photos → confirm → SSE through `validate`/`render` → `done` —
producing correct per-character results on both a solo and a two-character page. The browser
homepage has been verified the same way from a fresh clone, including through `homepage/` (the
real production-backed one) end to end via an actual browser render.

**Four real bugs found and fixed wiring `homepage/` up as a genuine client of this API** — worth
knowing since they're the kind that only show up under real cross-origin browser use, not
server-to-server testing:

1. **The SSE `/status` route silently had no CORS header.** `@fastify/cors` stages
   `Access-Control-Allow-Origin` via an `onRequest` hook using `reply.header()`, which is only
   ever flushed by Fastify's own `reply.send()` pipeline. This route calls `reply.hijack()` +
   `reply.raw.writeHead()` to stream directly, bypassing that pipeline — so the header was never
   sent, and a cross-origin `EventSource` failed CORS validation and went straight to a terminal
   `CLOSED` state with no retry. Same-origin/server-to-server calls never see this, which is why
   it went unnoticed. Fixed by setting the header explicitly in the `writeHead()` call, based on
   `request.headers.origin` matched against `env.CORS_ORIGIN`.
2. **One Redis connection per SSE subscriber, with no pooling.** `subscribeStatus` used to call
   `createRedisConnection()` fresh on every request; combined with a browser's automatic
   `EventSource` reconnect-on-drop, a burst of reconnects tripped Upstash's connection limits —
   observed live as `ECONNRESET` and even `getaddrinfo ENOTFOUND` for the Redis host, which
   looked exactly like a Redis outage but wasn't (a single plain connection worked immediately
   after). Fixed with one shared, long-lived `PSUBSCRIBE session:*` connection fanning out to an
   in-process `EventEmitter` — Redis connection count is now O(1) in concurrent viewers, not
   O(n), and ioredis auto-resubscribes this connection on a genuine reconnect.
3. **An unhandled promise rejection could crash the whole process.** `subscribeStatus` called
   `subscriber.subscribe(...)` with `void` and no `.catch()`; if the connection closed before
   that command completed (exactly what a fast reconnect/disconnect cycle produces), the
   rejection was unhandled, and Node crashes the process on an unhandled rejection by default —
   taking the BullMQ worker down with it, since they share a process. This is what made a render
   look like it "jumped straight from queued to done" with no progress text: the render kept
   going (or had already written pages to R2), but the process streaming progress had died.
4. **A double-job architecture made solo-mode renders ~2x slower than necessary.** Uploading the
   last photo auto-enqueues a `"preview"` job; a naive client that also wants the whole book
   right away and separately calls `render-full` gets *two* sequential BullMQ jobs (worker
   concurrency defaults to 1), not one. `upload-confirm`'s new `mode: "full"` field lets a caller
   skip straight to one job rendering every page concurrently instead.

**Open risks, in priority order:**

1. **Licensing.** The swap model (InsightFace inswapper) is published for non-commercial and
   research use only. InsightFace sell a separate commercial licence, which this paid product
   needs before launch. Most open face-swap tools (roop, facefusion, SimSwap) derive from the
   same model and inherit the restriction. **This blocks selling, not building.**
2. **The single-character page art is not shippable.** `astronaut`, `plane` and `workshop` are
   screenshots of a competitor's preview flow with French UI chrome baked into the pixels
   (which is what the `crop` field in `catalog.ts` strips). They demonstrate the engine fine,
   but they need replacing with real illustration.
3. **Non-determinism, undersampled.** Each verified result rests on one or two runs, and the
   same photo and page will not reproduce a previous output. Past "confirmed" fixes have hidden
   real bugs exactly this way. Anything reliability-related needs N≥5 runs before it is settled.
4. **`render-full`** (rendering the rest of the book after a preview) has not been exercised
   through the real API.

**Template art must be soft-shaded/painterly, not flat vector or chibi.** The swap model's own
internal face detector — separate from our blazeface check — reliably fails on flat-colour,
thick-outline art and on chibi proportions (giant anime eyes, round blob head), reporting
`status: "succeeded"` with no output and only "No face found" in the logs. The repaint prompt
now forces realistic facial geometry to counter this, but brief any new template art
accordingly before investing in it.

**Do not try to fix child facial geometry with prompt text.** It has failed three times over —
hair length, doubled eyebrows, and eye size. Even a concrete "each eye is one fifth of the face
width" instruction did not shrink a child's eyes, though the adult character on the same page
complied. Eye size is fixed downstream in `stages/eyes.ts` instead.

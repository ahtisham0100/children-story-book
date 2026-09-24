# Development Plan — Personalized Children's Book Platform

**Prototype: Photo-to-Illustration Pipeline**
Client: _private engagement_ · Engagement: Prototype build · Delivery window: **3 days**

---

> ## ⚠️ HISTORICAL RECORD — NOT THE CURRENT ARCHITECTURE
>
> **Written 2026-07-15 as the pre-build plan. The build then pivoted twice.** Most of
> the technical design below — the pipeline steps, the data model, the API surface, the
> stack table — describes systems that were **built, measured, and replaced**. The files
> it names (`portrait.ts`, `removeBg.ts`, `composite.ts`, `skinTone.ts`, `tone.ts`,
> `faceSwap.ts`) **no longer exist in this repository.**
>
> **For what the system actually does today, read
> [apps/api/README.md](apps/api/README.md).** That is the live architecture document.
> For running a demo, read [docs/DEMO_RUNBOOK.md](docs/DEMO_RUNBOOK.md).
>
> This file is kept deliberately, and is still worth reading for two things:
>
> - **The Decision Log** below — why the architecture changed, twice, with the evidence
>   that forced each change. Re-litigating a replaced approach costs real money.
> - **§1, §2, §15, §16** — the original scope lock and the client-commitment mapping,
>   which are unchanged and still binding.
>
> Sections whose technical content is superseded are flagged individually, so a section
> read on its own cannot mislead. **§14 (Deliverables) has been kept current** — it is
> the one status-bearing section in this file.
>
> _Accuracy pass: 2026-07-19._

---

## Decision Log

| Date | Decision | Effect |
|------|----------|--------|
| 2026-07-15 | **API-only** engagement — browser test UI **not** built this phase | `apps/web` deferred; Swagger UI at `/docs` is the interactive demo surface. *(Update: the planned `test/e2e.http` collection was never created — QA is driven by `apps/api/test/e2e-single.mjs` and `e2e-multichar.mjs` instead. A standalone browser demo UI did later ship in `apps/api/demo/`, outside the deferred `apps/web`.)* |
| 2026-07-15 | GitHub repo: **public**, owner's account, `gh` CLI setup | See §11 |
| 2026-07-16 | Face detection: `@tensorflow/tfjs` + `blazeface` instead of `face-api.js` | Avoids the native `canvas` package, a real build risk on Windows under this deadline; bounding boxes are sufficient for single-face validation. See `apps/api/README.md` |
| 2026-07-16 | ~~Portrait model: free public Hugging Face Space (`InstantX/InstantID`), not Replicate~~ **SUPERSEDED** | No card/budget available at the time. Trade-off: shared free GPU queue, community-maintained. **Dead — there is no portrait step any more.** The ZeroGPU daily quota (~2 min for anonymous callers) made it unworkable, and the whole generate-a-portrait design was replaced twice over; see the 2026-07-17 rows. |
| 2026-07-16 | Pipeline job: single BullMQ job per session, `attempts: 1` (no auto-retry), not per-step retry differentiation | Per-step retry policy would need BullMQ flows (linked jobs) — more machinery than a 3-day prototype warrants; failures surface immediately via the `error` SSE event |
| 2026-07-16 | **Scope pivot: multi-character + template-based compositing**, superseding the single-character "generate one preview" design | Client wants a small-scale proof of Imagitime's actual architecture (one stylized portrait per child, reused via fast compositing — not regenerated per page) plus **true multi-character** now, not deferred. New Session→many Character data model, per-character upload endpoints, and a new `composite` pipeline step. Full detail in the approved plan; see §17 below and `apps/api/README.md` |
| 2026-07-17 | **Second pivot: face-swap onto finished artwork, superseding §17's generate-a-portrait-then-composite design** | The free HF Space's ZeroGPU quota (~2 min/day for anonymous callers, see §17) made repeated generation unworkable, and diffusion still fought identity/pose drift even within quota. Replaced with `codeplugtech/face-swap` (Replicate, InsightFace inswapper) swapping the child's face directly onto the character the illustrator already drew and posed — no diffusion, no per-template calibration, no portrait/remove_bg/composite steps. `portrait.ts`/`removeBg.ts`/`composite.ts` deleted. **New, unresolved risk this pivot introduces:** inswapper is licensed for non-commercial/research use only — needs a commercial licence before this can ship as a paid product. **This decision was itself superseded the same day — see the row below.** |
| 2026-07-17 | **Third pivot (CURRENT ARCHITECTURE): repaint the whole illustration, THEN swap for identity** | Swap-alone was measured and found insufficient — it changed only **~0.43%** of a page, leaving the wrong hair, an unwanted headband and pale hands. It is an identity stage, not an engine. The pipeline became five stages: **repaint** (`google/nano-banana`, ~$0.039) redraws the whole illustration as this child, then **swap** (~$0.006) pins the likeness, then **restore**/**heal**/**eyes** clean up. The repaint *sees the photograph*, so one generic prompt personalizes any child with no per-child tuning and no per-template calibration, and because it redraws cohesively there are no seams or halos. Masked inpainting (FLUX Fill) was tried before this and rejected by the client for visible seams and a bright hair halo. **Neither replaced approach should be revisited.** Cost and latency live in different stages: repaint dominates cost, swap dominates latency (~55-90s). Full detail in `apps/api/README.md`. |
| 2026-07-19 | **Consolidation: one engine, one catalog** | Three overlapping page registries and four demo CLI drivers were merged into a single `catalog.ts` + one `personalize.ts` entry point, so production and the demo harness provably run the same code. Skin-tone extraction was removed end to end (code, DB column, API field) — it was computed, stored, passed in, and never read. `skinTone.ts`, `faceSwap.ts` and a broken `demo/demo.mts` deleted. See `apps/api/README.md` for the resulting file map. |

---

## 0. How to read this document

> **This was written as the single source of truth, and is no longer.**
> `apps/api/README.md` holds the current architecture. What follows is the plan as it
> stood at kickoff, retained as a record of intent and of what the client was promised.

It expands the client proposal into an executable engineering plan. Every item in the
proposal's "Included in Prototype" list is mapped to a concrete task, owner, file, and
acceptance check below — and §14 records how each one actually landed, including the
several that were delivered by a different mechanism than planned.

- **Section 1–2** — scope lock (what we build, what we explicitly do not)
- **Section 3–8** — the technical design (stack, architecture, data, pipeline, API, frontend)
- **Section 9** — infrastructure & secrets provisioning (the parts that need client/us action)
- **Section 10** — the compressed **3-day** build schedule (proposal's 5–7 day plan, resequenced)
- **Section 11** — Git & GitHub workflow and the commit cadence
- **Section 12** — testing & acceptance criteria (definition of "done")
- **Section 13** — risk register & fallback plan (the portrait-generation risk)
- **Section 14** — deliverables checklist mapped 1:1 to the proposal
- **Section 15** — what we need from the client, and by when
- **Section 16** — explicitly deferred scope (Phase 2+)

---

## 1. Scope — Included in Prototype

> **Capability list still binding; the mechanism below is superseded.** The numbered
> capabilities are what the client was promised and §14 tracks each one. The pipeline
> arrow-diagram directly below describes the *original* design — background removal,
> portrait generation and skin-tone extraction no longer exist. Scope also grew on
> 2026-07-16 from one character to **true multi-character** (§17).
>
> **What actually runs today:** `upload → face validation → repaint → swap → restore →
> heal → eyes → live SSE status → preview page(s)`.

The prototype was originally scoped as a single end-to-end loop for **one child
character, one story, one preview image**:

> upload → face validation → background removal → portrait generation → skin-tone
> extraction → compositing → live SSE status → one preview image → test UI + API docs

| # | Capability | Proposal source |
|---|------------|-----------------|
| 1 | Photo upload (presigned, direct-to-storage) | Included list |
| 2 | Face validation (detect exactly one usable face, check resolution/type) | Included list |
| 3 | Background removal | Included list |
| 4 | Portrait / illustrated-character generation (off-the-shelf, **not** fine-tuned) | Included list + risk disclosure |
| 5 | Skin-tone extraction | Included list |
| 6 | Compositing character onto a scene template | Included list |
| 7 | Live status via Server-Sent Events | Included list |
| 8 | One final preview image | Included list |
| 9 | ~~Browser test UI~~ → **deferred** (client confirmed **API-only**, 2026-07-15) | Included list |
| 10 | Documented API (OpenAPI/Swagger) — **primary interface & demo surface** | Included list |

## 2. Scope — Explicitly OUT (do not build)

> **⚠️ ONE ITEM MOVED IN.** ~~Multi-character~~ was **pulled into scope on 2026-07-16** at
> the client's request and is **built** — 2+ real children on one page, each detected and
> personalized independently (§17). Everything else in this list is still out.

~~Multi-character~~ (**now in scope and delivered**) · multi-page preview · cart/checkout
(Stripe) · 300 DPI CMYK print PDF · print-provider integration (Gelato/Lulu) · admin
dashboard · GDPR deletion workflow + audit log · auth/accounts · transactional email
(Resend) · full i18n rollout beyond the single test locale.

These are tracked in **Section 16** so the client sees they are deliberately deferred,
not forgotten.

---

## 3. Tech Stack (locked)

> **⚠️ SUPERSEDED IN PART.** Runtime, language, framework, database, ORM, queue, storage
> and SSE are all accurate. The image-pipeline rows are not. Corrections:
>
> | Row | Planned | Actually built |
> |---|---|---|
> | Face detection | face-api.js → Rekognition fallback | **`@tensorflow/tfjs` + blazeface** (local, free) |
> | Background removal | remove.bg API | **removed** — no such step exists |
> | Skin-tone extraction | Sharp pixel sampling | **removed 2026-07-19** — computed but never read |
> | Portrait generation | Replicate ControlNet/IP-Adapter/InstantID | **removed** — replaced by repaint-then-swap |
> | Compositing | Sharp template + portrait | **replaced** by feathered crop overlay for multi-character pages only |
> | *(new)* Repaint | — | **`google/nano-banana`** ~$0.039 |
> | *(new)* Swap | — | **InsightFace inswapper** ~$0.006 |
> | *(new)* Restore | — | **CodeFormer** |
>
> The "no stack deviations" line below is therefore **no longer true** — it was true on
> the day it was written.

| Layer | Choice | Notes |
|-------|--------|-------|
| Runtime | **Node.js 20 LTS** (dev machine runs 22 — pinned via `.nvmrc`/`engines`) | matches BullMQ/Sharp ecosystem |
| Language | **TypeScript** (strict) | shared types across api/web |
| API framework | **Fastify** | native async, first-class SSE, `@fastify/swagger` for docs |
| Database | **PostgreSQL** (Neon free tier) | UUID sessions |
| ORM | **Prisma** | fast schema iteration + typed client |
| Queue | **BullMQ + Redis** (Upstash free tier) | per-step retry/backoff |
| Object storage | **Cloudflare R2** (S3-compatible) | presigned PUT/GET, no egress fee |
| Face detection | **face-api.js** (self-hosted, $0) → fallback **AWS Rekognition** if accuracy insufficient | cost-first |
| Background removal | **remove.bg API** | as specified |
| Skin-tone extraction | **Sharp** (pixel sampling) | no external API |
| Portrait generation | **Replicate** — ControlNet / IP-Adapter / InstantID / PhotoMaker class model | off-the-shelf, **flagged risk** |
| Compositing | **Sharp** | template + portrait → JPG |
| Realtime status | **Server-Sent Events** (native) | one-way stream; no socket.io |
| Frontend | **Next.js 14 (App Router) + Tailwind** | test UI only for prototype |
| Hosting | API: Railway/Render · Web: Vercel · Redis: Upstash · DB: Neon · Storage: R2 | free/cheap tiers |

**Stack deviations from the proposal:** none. Node 22 on the dev box is a superset of
Node 20; we pin `engines.node` to `>=20` and target 20 LTS behavior.

---

## 4. Architecture Overview

> **⚠️ SUPERSEDED.** The transport shape (presigned R2 upload, Fastify, BullMQ worker,
> Redis pub/sub, SSE, Prisma/Postgres) is still exactly right. The **worker steps in the
> diagram are wrong** — `remove_bg → skin_tone → portrait → composite` no longer exist.
> Today the worker runs `validate` per character, then a single `render` step covering
> repaint → swap → restore → heal → eyes. The Next.js UI shown is deferred and unbuilt.
> Current diagram and flow: [apps/api/README.md](apps/api/README.md).

```
┌────────────┐   presigned PUT    ┌──────────────┐
│  Next.js   │ ─────────────────▶ │  Cloudflare  │
│  test UI   │                    │      R2      │
│ (Vercel)   │ ◀───── preview ─── │  (objects)   │
└─────┬──────┘   signed GET       └──────▲───────┘
      │  REST (create/confirm)           │ read/write keys
      │  SSE  (status stream)            │
      ▼                                  │
┌───────────────────────────┐   enqueue  │
│      Fastify API          │ ─────────┐ │
│  (Railway/Render)         │          │ │
│  - /api/sessions          │          ▼ │
│  - /upload-url /confirm   │   ┌─────────────────┐
│  - /status (SSE)          │   │  BullMQ worker  │
│  - /preview               │   │  pipeline queue │
│  - /docs (OpenAPI)        │◀──│  validate →     │
└──────────┬────────────────┘   │  remove_bg →    │
           │ Prisma             │  skin_tone →    │
           ▼                    │  portrait →     │
     ┌───────────┐  progress    │  composite      │
     │ Postgres  │◀─────────────│  (updates rows, │
     │  (Neon)   │              │   emits events) │
     └───────────┘              └───────┬─────────┘
           ▲                            │ external calls
           │  Redis pub/sub for SSE     ├─▶ remove.bg
     ┌───────────┐                      ├─▶ Replicate
     │  Redis    │◀─────────────────────┘   (ControlNet…)
     │ (Upstash) │
     └───────────┘
```

**Key flows**

1. **Upload** — UI asks API for a presigned R2 PUT URL, uploads the photo directly to
   R2 (bytes never transit our API), then confirms; confirm writes `rawKey` and enqueues
   the pipeline job.
2. **Processing** — one BullMQ job runs the five steps sequentially; each step updates the
   `Character` row and publishes a progress event on Redis.
3. **Status** — the SSE endpoint subscribes to that session's Redis channel and streams
   `status` / `done` / `error` events to the browser.
4. **Result** — the final composited preview is written to R2; UI shows it via a signed GET
   URL (`/preview` provides the same URL as a polling fallback if the SSE connection drops).

---

## 5. Data Model (Prisma — prototype-scoped)

> **⚠️ SUPERSEDED.** Three migrations have changed this. The live schema is
> `apps/api/prisma/schema.prisma`; the differences that matter:
>
> - `Session` has **many** `Character` (was 1:1), and `childName` moved onto `Character`.
> - `Character` gained `slot` (e.g. `child_1`), unique per session.
> - `noBgKey`, `portraitKey` and `skinToneHex` were **dropped** (migrations
>   `remove_dead_portrait_fields`, `remove_dead_skin_tone`) — the steps that wrote them
>   no longer exist.
> - Finished pages are not a DB column; they live at a derived R2 key
>   (`sessions/{id}/pages/{pageId}.png`).
> - `packages/shared` was **never populated** — the status vocabulary lives in
>   `apps/api/src/pipeline/types.ts` and the SSE copy in `apps/api/src/messages.ts`.

```prisma
model Session {
  id        String   @id @default(uuid())
  locale    String   @default("fr")
  storyId   String
  childName String
  status    String   @default("created") // created | uploaded | validated | processing | done | failed
  createdAt DateTime @default(now())
  character Character?
}

model Character {
  id          String  @id @default(uuid())
  sessionId   String  @unique
  session     Session @relation(fields: [sessionId], references: [id])
  role        String  @default("child") // fixed to "child" for prototype
  rawKey      String? // R2 key, original upload
  noBgKey     String? // after remove.bg
  skinToneHex String? // sampled skin tone
  portraitKey String? // illustrated asset, transparent bg
  previewKey  String? // final composited preview
  jobId       String? // BullMQ job id for status lookup
}
```

Status vocabulary is shared as a TypeScript union in `packages/shared` so API, worker, and
UI never drift.

---

## 6. Pipeline (BullMQ)

> **⚠️ SUPERSEDED.** One queue, one job per session is still correct. The **step table
> below is not** — four of its five steps no longer exist. Today: `validate` runs per
> character in parallel (blazeface, local, free), then one `render` step renders every
> page for the mode, up to `PAGE_CONCURRENCY` (default 3) pages in flight, each page
> running repaint → swap → restore → heal → eyes per drawn character.
>
> Two other corrections: retries are **`attempts: 1`** (not 2 with backoff — see the
> 2026-07-16 decision log row; retries happen at the HTTP level inside a call instead),
> and there are **two** user-facing copy strings, not five, because the five image
> stages are reported to the user as one `render` step.

**One queue** (`pipeline`), **one job per session**. Multi-queue with dead-letter routing
is a Phase-2 concern — out of scope here.

| Step | Action | Writes | Emits (SSE `status`) |
|------|--------|--------|----------------------|
| `validate` | face-api.js: exactly one detectable face; check min resolution + mime | — (fail → `status=failed`) | "Checking your photo…" |
| `remove_bg` | remove.bg API on the raw image | `noBgKey` | "Preparing your characters…" |
| `skin_tone` | Sharp: sample face-region pixels, average → hex | `skinToneHex` | "Matching skin tone…" |
| `portrait` | Replicate ControlNet/IP-Adapter call, poll to completion | `portraitKey` | "Creating your illustrated characters…" |
| `composite` | Sharp: load scene template + portrait, position/scale, export JPG | `previewKey` | "Building your story pages…" |

Rules:
- Each step is wrapped in `try/catch`. On failure: set `status = failed`, emit an `error`
  event with a **user-facing** message (never a raw stack trace) plus the failing `step`.
- BullMQ per-job retry: `attempts: 2`, exponential backoff — but **not** for `validate`
  (a bad photo won't get better on retry; fail fast and ask the user to re-upload).
- Progress is published to Redis channel `session:{id}` which the SSE route subscribes to.
- The exact user-facing copy strings are centralized in `packages/shared/messages.ts` so
  they match the proposal wording and are ready for i18n later.

---

## 7. Backend API Surface

> **⚠️ SUPERSEDED.** The upload endpoints are now per-character, and two endpoints below
> (`/preview`, the single-character `/upload-url`) do not exist. The live surface is
> generated from route schemas and browsable at `/docs`; it is tabulated in
> [apps/api/README.md](apps/api/README.md#endpoints). In short:
>
> ```
> POST /api/sessions                                              { storyId, characters: [{slot, childName}] }
> GET  /api/sessions/:id
> POST /api/sessions/:id/characters/:characterId/upload-url
> POST /api/sessions/:id/characters/:characterId/upload-confirm   enqueues once ALL characters have uploaded
> POST /api/sessions/:id/render-full                              renders the rest of the book
> GET  /api/sessions/:id/pages                                    per-page status + signed URLs
> GET  /api/sessions/:id/status                                   SSE
> ```
>
> The object-key namespacing note below is also stale: keys are
> `sessions/{id}/pages/{pageId}.png`, with no `/nobg` or `/portrait`.

```
POST /api/sessions
  body: { locale, storyId, childName }
  → 201 { sessionId }

POST /api/sessions/:id/upload-url
  → 200 { uploadUrl, objectKey }        # presigned R2 PUT, 60s expiry

POST /api/sessions/:id/upload-confirm
  body: { objectKey }
  → 200 { ok: true }                    # writes rawKey, enqueues pipeline job

GET  /api/sessions/:id/status           # text/event-stream (SSE)
  event: status  data: { step, message }
  event: done    data: { previewUrl }
  event: error   data: { step, message }

GET  /api/sessions/:id/preview
  → 200 { previewUrl }                  # signed R2 GET, polling fallback for SSE drops

GET  /docs                              # Swagger UI (OpenAPI 3) — "documented API" deliverable
```

**Validation & hardening (prototype-appropriate):** request bodies validated by Fastify
JSON schema (feeds OpenAPI for free); upload URLs constrained to expected content-type and
size; object keys namespaced by session id (`sessions/{id}/raw`, `/nobg`, `/portrait`,
`/preview`); permissive CORS limited to the Vercel preview origin.

OpenAPI is generated automatically from route schemas via `@fastify/swagger` +
`@fastify/swagger-ui` — near-zero manual doc effort, always in sync.

---

## 8. Client / Demo Interface — API-only (test UI deferred)

> **Decision 2026-07-15:** the client confirmed an **API-only** engagement, so the Next.js
> browser test UI is **deferred to a later phase**. The demo and QA surface for this build is:
>
> - **Swagger UI at `/docs`** — interactive, click-to-run documentation of every endpoint.
> - **`test/e2e.http`** — a checked-in REST Client collection.
> - **`test/e2e.mjs`** — a small Node script for an automated end-to-end pass.
>
> The reference UI design below is retained for the future phase when the browser UI is added.

> **⚠️ CORRECTION.** Neither `test/e2e.http` nor `test/e2e.mjs` was ever created. The
> actual QA scripts in `apps/api/test/` are `e2e-single.mjs`, `e2e-multichar.mjs`,
> `list-past-runs.mjs` and `download-run-images.mjs`.
>
> Separately, a **standalone browser homepage did ship** — `apps/api/homepage`, run with
> `npm run homepage`. It is not the deferred `apps/web` Next.js UI described below: it is
> a self-contained Fastify page that calls the same pipeline functions the production
> worker calls, with no Postgres, Redis, BullMQ or S3 dependency, so a client demo cannot
> be taken down by infrastructure unrelated to what is being shown. See
> [docs/DEMO_RUNBOOK.md](docs/DEMO_RUNBOOK.md).

### (Reference — deferred) Next.js test UI, single page

No auth, no routing complexity. One page, four states:

1. **Form** — story dropdown (one hardcoded story) + child-name input → `POST /api/sessions`.
2. **Upload** — file input → request presigned URL → `PUT` directly to R2 → `POST upload-confirm`.
3. **Status** — open `EventSource('/api/sessions/:id/status')`, render the five steps as a
   checklist that lights up in order, using the exact proposal copy
   ("Preparing your characters…", "Creating your illustrated characters…",
   "Building your story pages…"). Polling fallback on SSE error.
4. **Result** — show the final preview image + a "Try another photo" reset button.

Client-side guards: image type/size check before requesting an upload URL; disabled submit
while a pipeline is in flight; graceful error card on the `error` SSE event.

---

## 9. Infrastructure & Secrets Provisioning

> **⚠️ PARTLY SUPERSEDED.** The provisioning steps and the who-creates-what principle
> still stand. But **`REMOVEBG_API_KEY` and `REPLICATE_MODEL_VERSION` are not used** —
> remove.bg was designed out, and models are pinned in code rather than by env var. A
> remove.bg account is **not** needed.
>
> The `.env` contract below is also out of date and lives in the wrong place: the real
> one is **`apps/api/.env.example`** (not the repo root), and it is authoritative.
> Note that the **demo harness needs only `REPLICATE_API_TOKEN`** — no database, Redis
> or storage — which is the fastest way to see the engine work.

All chosen services have free tiers. **Account creation requires the client's/owner's own
sign-in** — I will not create third-party accounts or enter credentials on your behalf. For
each service below I'll provide exact setup steps; you create the account and paste the key
into our shared secret store (or send securely), and I wire it in.

| Service | Purpose | Who provisions | Secret(s) produced |
|---------|---------|----------------|--------------------|
| Neon | Postgres | you (or me with your login) | `DATABASE_URL` |
| Upstash | Redis | you | `REDIS_URL` |
| Cloudflare R2 | Object storage | you | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` |
| remove.bg | Background removal | you | `REMOVEBG_API_KEY` |
| Replicate | Portrait generation | you | `REPLICATE_API_TOKEN`, `REPLICATE_MODEL_VERSION` |
| Railway/Render | API hosting | you/me | — |
| Vercel | Web hosting | you/me | — |

**`.env` contract** (see `.env.example` in repo root):

```
DATABASE_URL=
REDIS_URL=
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_NAME=
REMOVEBG_API_KEY=
REPLICATE_API_TOKEN=
REPLICATE_MODEL_VERSION=
```

Secrets are **never** committed. `.env` is git-ignored; only `.env.example` (keys, no values)
is tracked. On the hosts, secrets are set as environment variables in the dashboard.

---

## 10. Build Schedule — Compressed to 3 Days

> **Historical.** This schedule was executed, then overtaken by the two pivots in the
> decision log; Day 2's "risk step" (portrait generation) no longer exists as a step.
> Delivery status is tracked in §14, not here.

The proposal budgets 5–7 working days; we're targeting **3**. This is achievable only if the
client assets (Section 15) arrive at kickoff. The plan front-loads the risk step
(portrait generation) so we discover model quality on Day 2, leaving Day 3 for iteration.

### Day 1 — Foundation & the upload loop
- Monorepo scaffold (`apps/api`, `apps/web`, `packages/shared`), TypeScript strict, tooling.
- Provision Neon, Upstash, R2 (or wire the keys you provide).
- Prisma schema + first migration; typed client.
- Fastify app + health check + `@fastify/swagger` mounted at `/docs`.
- `POST /api/sessions`, `POST /upload-url`, `POST /upload-confirm` (presigned R2, writes `rawKey`).
- `test/e2e.http` collection covering create → upload-url → PUT → confirm.
- **Milestone D1:** a photo can be uploaded to R2 via the API (Swagger/`.http`) and a session row exists.

### Day 2 — Pipeline, status stream & the risk step
- BullMQ queue + worker wiring; `validate` (face-api.js) and job enqueue on confirm.
- SSE `GET /status` (Redis subscribe); verified with the `test/e2e.mjs` `EventSource` consumer.
- `remove_bg` (remove.bg) and `skin_tone` (Sharp) steps, results persisted to R2/DB.
- **`portrait` (Replicate)** integration — the flagged risk — tested against the style
  references so we learn quality early.
- **Milestone D2:** live status streams end-to-end through skin-tone; a first illustrated
  portrait exists from a real photo.

### Day 3 — Compositing, hardening, docs, polish
- `composite` (Sharp): portrait onto scene template → preview JPG → `previewKey`; wire the
  `done` SSE event with the signed preview URL.
- Portrait-quality iteration (try alternate Replicate models per Section 13 if needed).
- Error handling: `error` SSE event with user-facing messages; `/preview` polling fallback verified.
- OpenAPI docs reviewed at `/docs`; README run instructions; deploy API to host (Railway/Render).
- Full end-to-end pass with real photo(s) via `test/e2e.mjs`; demo walkthrough on Swagger `/docs`.
- **Milestone D3 (Delivery):** upload → preview works end-to-end, API deployed, documented.

> If portrait quality is still below bar at end of Day 3, we ship the best achieved result
> **clearly labeled as pre-fine-tuning quality** (per the proposal's disclosure) with a
> documented failure mode to scope the fine-tuning phase — see Section 13.

---

## 11. Git & GitHub Workflow

- **Repo:** a dedicated GitHub repository for the prototype (name/visibility confirmed with
  client — recommend **private** for client work).
- **Branching:** trunk-based for a solo 3-day sprint. Short-lived feature branches per major
  piece (`feat/upload-loop`, `feat/pipeline`, `feat/portrait`, `feat/compositing`) merged to
  `main` via small commits; `main` stays runnable.
- **Commit cadence (the "timely commits" requirement):** commit at every working checkpoint
  — roughly per API endpoint, per pipeline step, per UI state. Conventional Commits style
  (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`). Each commit message states what
  and why. Target several commits per build session, not one giant end-of-day dump.
- **Tags/milestones:** tag `d1-upload-loop`, `d2-pipeline`, `d3-delivery` at each milestone.
- **Secrets never committed**; `.gitignore` covers `.env`, `node_modules`, build output,
  Prisma local artifacts, and R2/model caches.
- **Co-authorship** footer on commits as configured.

---

## 12. Testing & Acceptance Criteria (Definition of Done)

> **⚠️ SUPERSEDED.** The principle — done means it passes on a **real** photo — held
> throughout and still does. The table's rows for background removal, skin tone,
> portrait and compositing test steps that no longer exist, and it names the two scripts
> that were never written (see §8). The planned unit tests for skin-tone sampling and
> compositing geometry were not written either; skin-tone sampling was deleted, and
> compositing geometry is verified instead by the free `--detect-only` preflight, which
> writes the exact crops the models would receive.
>
> **What "done" means today, and what has actually been verified, is the "Known state"
> section of [apps/api/README.md](apps/api/README.md)** — including the open risks and
> the caveat that most results rest on one or two runs against a non-deterministic
> pipeline.

A capability is "done" only when its acceptance check passes on a **real** photo.

| Capability | Acceptance check |
|-----------|------------------|
| Upload | Photo lands in R2 under `sessions/{id}/raw`; session row `status=uploaded`. |
| Face validation | One-face photo passes; zero-face and multi-face photos fail with a clear message; below-min-resolution fails. |
| Background removal | `noBgKey` object has transparent background. |
| Skin tone | `skinToneHex` is a plausible skin-tone hex sampled from the face region. |
| Portrait | `portraitKey` is an illustrated, transparent-background character resembling the child (quality caveat per Section 13). |
| Compositing | `previewKey` JPG shows the character placed/scaled correctly in the scene template. |
| SSE status | `test/e2e.mjs` `EventSource` logs all five steps with the exact copy; `done`/`error` handled. |
| Preview | Final image renders in the UI; `/preview` returns the same signed URL. |
| API docs | `/docs` renders OpenAPI for every endpoint. |

**Test method (API-only):** scripted E2E via `test/e2e.http` (Swagger UI for interactive
runs) and `test/e2e.mjs` (automated pass with an `EventSource` SSE consumer), against a
fixture photo for repeatable QA. Automated unit tests are minimal by design for a 3-day
prototype — focused on the two pure functions worth locking down (skin-tone sampling,
compositing geometry).

---

## 13. Risk Register & Fallback Plan

> **⚠️ SUPERSEDED — and the original register no longer contains the top risk.**
> The kickoff register below is retained as a record of what was anticipated. Every row
> in it is now either resolved or obsolete: the flagged portrait-quality risk was
> resolved by designing portrait generation out entirely, and the face-api.js and
> remove.bg rows describe dependencies that were never adopted or were removed.
>
> **The live register, in priority order:**
>
> | # | Risk | Impact | Status |
> |---|---|---|---|
> | 1 | **Licensing.** InsightFace **inswapper** — the swap model — is published for non-commercial/research use only. InsightFace sell a separate commercial licence. Most open face-swap tools (roop, facefusion, SimSwap) derive from it and inherit the restriction. | **Blocks selling, not building.** | **OPEN, unmitigated.** Deliberately deferred to finish the prototype first. Needs raising with the client **before** launch, not at it. |
> | 2 | **Single-character page art is not shippable.** `astronaut`, `plane` and `workshop` are screenshots of a competitor's preview flow with French UI chrome baked into the pixels. | Demos fine; cannot ship. | OPEN. Needs real illustration. New art must be **soft-shaded/painterly** — the swap model's face detector reliably fails on flat vector and chibi art. |
> | 3 | **Non-determinism, undersampled.** Each verified result rests on one or two runs, and the same photo and page will not reproduce a previous output. | Past "confirmed" fixes have hidden real bugs this way. | OPEN. Anything reliability-related needs **N≥5** runs before it is settled. |
> | 4 | **`render-full` never exercised** through the real API. | Unknown-unknowns in the buy-the-book path. | OPEN. |
> | 5 | **Not deployed.** Still local-only; no shareable demo URL. | §14's one unchecked deliverable. | OPEN. |

### (Historical) Kickoff risk register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| **Portrait quality below bar** (off-the-shelf model, no fine-tune) — *the flagged risk* | Med–High | High | Front-loaded to Day 2. Try 2–3 alternate Replicate models (IP-Adapter, InstantID, PhotoMaker) before declaring blocked. Document exact failure mode (likeness loss / style mismatch / artifacts). Ship best result labeled pre-fine-tuning; scope fine-tuning precisely. |
| Client assets late (template, style refs, test photo) | Med | High (breaks 3-day timeline) | Requested at kickoff (Section 15); Day 1 has no hard dependency on them; portrait/composite (Day 2–3) do. Escalate immediately if not received by end of Day 1. |
| face-api.js accuracy too low | Low–Med | Med | Fallback to AWS Rekognition (`DetectFaces`) behind the same interface; swap is isolated to the `validate` step. |
| remove.bg free-tier limits / cost | Low | Low | Free credits sufficient for prototype QA volume; cache results; batch nothing. |
| Replicate cold starts / latency | Med | Low | Async job already tolerates minutes; SSE keeps user informed; poll with backoff. |
| SSE connection drops (proxies/timeouts) | Med | Low | `/preview` polling fallback + auto-reconnect on the `EventSource`. |
| Third-party account/keys blocked on client action | Med | Med | Section 9 lists exactly what's needed; I provide setup steps; I cannot create accounts or enter credentials for you. |

---

## 14. Deliverables Checklist (mapped to proposal)

**This is the one status-bearing section of this document and is kept current.**
Last reconciled against the code **2026-07-19**. Several original items were delivered by a
different mechanism than planned rather than left undone; each is marked.

- [x] Photo upload (presigned, direct-to-R2) — verified via real sessions
- [x] Face validation (single face + resolution/type) — `validate.ts`, verified. Uses
      **blazeface**, not the planned face-api.js.
- [x] ~~Background removal (remove.bg)~~ — **superseded, no longer applicable**: the engine
      repaints the illustrator's finished artwork in place, so there is no background to
      remove. `removeBg.ts` deleted.
- [ ] ~~Skin-tone extraction (Sharp)~~ — **superseded and removed 2026-07-19.** It was built
      and it worked, but it was computed, stored, passed in and **never read** by any stage,
      so it was deleted end to end (`skinTone.ts`, the `skinToneHex` column, the API field).
      Skin tone still carries into the result — the repaint sees the photograph directly and
      matches it, including on hands and body, which is what this item was for.
- [x] ~~Portrait / illustrated-character generation (Replicate, off-the-shelf)~~ —
      **superseded**: no separate portrait is generated. The page artwork itself is repainted
      as the child (`google/nano-banana`), then identity-locked with a face swap.
      `portrait.ts` deleted.
- [x] ~~Compositing character onto a scene template (Sharp)~~ — **superseded**: solo pages
      need no compositing at all (the whole page is repainted). Multi-character pages crop
      each drawn character, personalize each independently, and feather the finished crops
      back on — `compose.ts` (`characterCrop` / `cropOverlay`). `composite.ts` deleted.
- [x] Live SSE status with the specified copy — verified via real sessions. **Two steps
      (`validate`, `render`), not five** — the five image stages are deliberately reported to
      the user as one step.
- [x] One final preview image — verified end-to-end, single- and multi-character
- [x] ~~Browser test UI~~ — **deferred** (client confirmed API-only, 2026-07-15). Swagger UI
      at `/docs` plus `test/e2e-single.mjs` / `test/e2e-multichar.mjs` are the API demo/QA
      surface. **A standalone browser homepage was nonetheless built** and is the recommended
      client-facing surface: `apps/api/homepage`, `npm run homepage`.
- [x] Documented API (OpenAPI at `/docs`) — primary interface
- [ ] **Deployed prototype (API) with a shareable Swagger `/docs` demo URL — still
      local-only, not hosted.** The only outstanding deliverable.
- [x] GitHub repo with timely, meaningful commit history
- [x] This plan + README + architecture/API/risk docs — `apps/api/README.md` is the live
      architecture document; this plan was marked as a historical record on 2026-07-19.

**Scope delivered beyond the original list:** true multi-character pages (2+ real children on
one page, each detected and personalized independently), a five-page catalog across two books,
preview-vs-full render modes as a cost lever, and a free `--detect-only` preflight.

---

## 15. What I Need From You (kickoff blockers)

> **Historical — these were the kickoff asks and are resolved.** Item 3 was answered
> (API-only) and item 6 was answered (see decision log). Two remain live, but as
> **product** blockers rather than kickoff blockers, and they are tracked as risks 1–2
> in §13: real illustration to replace the competitor screenshots, and a commercial
> licence for the swap model. Item 1's "transparent placeholder region" is no longer how
> the engine works — it repaints finished artwork rather than compositing into a hole.

From the proposal's "What I need from you," due **as early as possible** to protect the 3-day
timeline:

1. **Scene template PNG** — one scene with a transparent placeholder region where the
   character is composited. (Needed by Day 2–3.)
2. **3–5 illustration style reference images** — to pick/tune the Replicate model to your
   art direction. (Needed by Day 2 — drives the risk step.)
3. **Confirm test UI scope** — browser test UI (recommended) **vs** API-only. Default: include the UI.
4. **One test photo of a child** — for our own QA before the demo (a stock/consented photo is fine).
5. **Service accounts / API keys** — Neon, Upstash, R2, remove.bg, Replicate (Section 9), or
   confirm you want me to set up the free-tier accounts under an account you own.
6. **GitHub** — desired repo name + **public or private** (recommend private) + which GitHub
   account owns it.

## 16. Explicitly Deferred to Later Phases

~~Multi-character compositing~~ — **pulled forward into scope, see §17** (2026-07-16).
Multi-page preview (the full 24-page/14-theme library) · Stripe cart/checkout · 300 DPI CMYK
print PDF + Gelato/Lulu integration · admin dashboard · GDPR deletion cron + audit log ·
auth/accounts · Resend transactional email · full next-intl i18n rollout beyond the single
test locale.

These are captured here so scope is transparent and nothing reads as "missing" — each is a
named Phase-2+ item, not an omission.

---

## 17. Multi-Character Pivot (2026-07-16)

> **⚠️ HALF SUPERSEDED — read the split carefully, this section is easy to misread.**
>
> **Still true and still binding:** the scope change. True multi-character (2+ real
> children in one scene) was pulled forward as a hard requirement, `Session` gained many
> `Character`, and the per-character API endpoints described here are the ones that
> exist today.
>
> **Superseded:** everything about *how* it was to be built. The "Architecture" paragraph
> below (generate one portrait per child, then cheaply composite it onto a fixed template
> face slot) was replaced the following day — see the 2026-07-17 decision log rows. There
> is no portrait step, no fixed face slot, and no hardcoded template geometry; face
> positions are detected per page at run time. The `two-children-park.png` template
> discussed below **does not exist in the repo**, and `composite.ts` is deleted.
>
> **Do not act on the instruction at the end of this section** to wait for a Hugging Face
> quota reset and re-run — that pipeline no longer exists. To verify multi-character
> today: `npm run personalize -- <child> <adult> --page newtemp` (or `--detect-only` first,
> which is free).
>
> The ZeroGPU quota post-mortem is kept because its two incidental fixes are still in the
> code and still matter: the unhandled `ioredis` error that crashed the server, and
> worker steps logging their full cause rather than only a generic SSE message.

Mid-build, the client sent reference material (screenshots of the Imagitime competitor app —
see decision log) revealing the real target architecture, and asked for two changes to the
originally-scoped single-character/"generate one preview" prototype:

1. **Don't regenerate a new image per page.** Imagitime's own claims (2-minute preview,
   24+ pages) only make sense if the expensive step — turning a real photo into an
   illustrated likeness — runs **once per child**, and each page is a fast compositing
   operation reusing pre-made artwork, not a full diffusion regeneration per page.
2. **True multi-character, now** — 2+ different real children combined in one scene,
   confirmed as a hard requirement (not deferred), even though Imagitime's own product only
   shows one recurring child across many page themes.

Confirmed with the client: no real template art exists yet (the client's screenshots weren't
usable artwork), so a placeholder template is being used, swappable later with no code
changes; today's target is proving the architecture at small scale (one template, two
character slots), not the full 24-page/14-theme library.

**Architecture:** Step A (per child, already-built `portrait` step) generates one stylized
reference portrait via the free HF Space. Step B (new `composite` step) crops that portrait's
face and blends it — via a soft feathered mask, not a hard-edged paste — onto a fixed
template's face slot using Sharp. No AI call for Step B, so adding pages later is cheap and
fast. Full reasoning (including why a literal ML face-swap tool wasn't used) is in the
approved plan and `apps/api/README.md`.

**Data model:** `Session` now has many `Character` (was 1:1); each `Character` has a `slot`
(matches a template face region) and its own `childName`. `Session.previewKey` holds the
final composited page.

**API:** `POST /api/sessions` now takes a `characters[]` array; upload endpoints move to
`/api/sessions/:id/characters/:characterId/upload-url|upload-confirm`; the pipeline enqueues
only once every character in the session has uploaded; SSE `status`/`error` events carry a
`slot` field.

**Template:** `assets/templates/two-children-park.png`, generated via the free
`black-forest-labs/FLUX.1-schnell` Hugging Face Space (no artist available yet). Its two face
slots were auto-detected with the existing blazeface model and hardcoded in `composite.ts`
(both faces were only found by detecting each half of the image separately — see
`apps/api/README.md` for why).

**Verification status:** the full pipeline (both characters through validate → portrait →
remove_bg → skin_tone → composite → done) was run successfully end-to-end once, proving the
architecture and multi-character mechanics work — but that run used the *first-pass* prompt
and compositing, which had visible quality issues (hard rectangular seams, stray
props/accessories bleeding into a crop from a too-elaborate generated scene). Both were fixed
(feathered-mask blending; a tightened headshot-only prompt), and the tightened prompt alone
was independently confirmed to produce a clean plain headshot.

A second **combined** confirmation run then failed repeatedly with a generic error at the
portrait step. Root-caused (after adding proper error logging — see `worker.ts`) to the real
cause: **the free HF Space runs on ZeroGPU, which gives anonymous/unauthenticated callers
only ~2 minutes of GPU quota per day** ([HF docs](https://huggingface.co/docs/hub/en/spaces-zerogpu)).
This session made 10+ calls to it while testing — comfortably enough to exhaust that quota,
after which the Space itself rejects further requests. This is **not a code or network bug**
— every individual piece (upload, call, poll, the generation itself) was independently
re-verified to work correctly right up until quota ran out. Two real, valuable fixes came out
of chasing this down regardless: an unhandled `ioredis` connection error was found to crash
the whole server (now has an error handler — see `src/redis.ts`), and worker step failures
now log their full error/cause to the console instead of only a generic message reaching the
SSE event (`src/worker.ts`), so this kind of root cause is immediately visible next time
without needing to re-derive it.

**Practical implication:** the anonymous free-tier path is fine for prototyping but not for
repeated demo/production use — 2 minutes/day is roughly 1-3 generations. Options if this
becomes a blocker: sign in with a free HF account for the API calls (3.5 min/day instead of
2 — a marginal improvement, not a fix), wait for the daily quota reset, or switch to a paid
model (Replicate version preserved in git history, or HF PRO at $9/mo for 25 min/day). **Once
today's quota resets, re-run `node test/e2e-multichar.mjs <photo1> child_1 <name1> <photo2>
child_2 <name2>` once** to get the final combined visual confirmation before a client demo —
expected to succeed cleanly based on every component's individual verification.

---

*Owner: Affan Ahmed · Prototype engagement (client confidential) · This document is versioned
in the repo. It is now a **historical record** of the plan and how it changed; §14 is the one
section kept current. The live architecture document is
[apps/api/README.md](apps/api/README.md).*

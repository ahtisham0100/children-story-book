# Personalized Children's Book Platform — Prototype

Photo-to-illustration pipeline: parents upload their children's photos and receive an
illustrated **preview** of those children drawn into a story page — plus, as of
2026-08-30, a full cart → Stripe checkout → print-PDF → Gelato dispatch → order-tracking
flow to actually buy the finished book.

> **Architecture and current state: [apps/api/README.md](apps/api/README.md) — read this
> first** for the personalization engine. **[docs/CART_CHECKOUT_SETUP.md](docs/CART_CHECKOUT_SETUP.md)**
> covers the cart/payments/print-dispatch layer, including live-verification results
> against real Stripe/Gelato/Resend test infrastructure and the full go-live checklist.
>
> [PROJECT_PLAN.md](PROJECT_PLAN.md) is the kickoff engineering plan and is a **historical
> record**: it describes two architectures that were built and replaced, and names several
> files that no longer exist, including calling cart/checkout "Phase 2+, out of scope" —
> that shipped on 2026-08-30. It carries a banner saying so, and each superseded section is
> flagged individually. [docs/DEMO_RUNBOOK.md](docs/DEMO_RUNBOOK.md) is how you actually run
> a demo of the personalization engine.

## What it does

```
per character: upload → face validation (local, free)
per page:      repaint the illustration as this child → swap for exact identity
               → restore → heal → eye fix
               → live status (SSE) → preview image
then:          add to cart → Stripe checkout → full-book render → 300 DPI CMYK print PDF
               → Gelato print dispatch → order-status tracking → Resend confirmation email
```

The repaint stage sees the photograph directly, so one generic prompt personalizes any child
with no per-child tuning and no per-template calibration. Multi-character pages crop each
drawn character out, personalize them individually, and feather the results back onto the
page. Full detail in [apps/api/README.md](apps/api/README.md).

## Repository layout

```
childrens-book-platform/
├── package.json          # root orchestrator — `npm run dev` boots everything at once
├── PROJECT_PLAN.md        # kickoff plan — HISTORICAL RECORD, see the banner at its top
├── README.md              # you are here
├── docs/
│   ├── CART_CHECKOUT_SETUP.md  # Stripe/Gelato/Resend setup, live-verification results,
│   │                            #   go-live checklist — start here for the cart/checkout layer
│   ├── DEMO_RUNBOOK.md         # how to demo the personalization engine
│   ├── DEMO_PLAN.md            # superseded 2026-07-17 demo plan, kept for its findings
│   ├── PROTOTYPE_OVERVIEW.md   # architecture/flow map for the personalization engine
│   ├── INFRA_AND_PIPELINE_TRACE.md
│   ├── CLIENT_UPDATE.md        # client-facing progress note (local-only, git-ignored)
│   └── superpowers/
│       ├── specs/              # design docs (e.g. the cart/checkout/print-dispatch spec)
│       └── plans/               # implementation plans, task-by-task
├── apps/
│   ├── api/               # Fastify + TypeScript backend, BullMQ worker, SSE, OpenAPI —
│   │   │                  #   the personalization engine (src/pipeline/) AND cart/
│   │   │                  #   checkout/print-dispatch (src/routes/checkout.ts,
│   │   │                  #   src/fulfillment.ts, src/print/, src/email/)
│   │   ├── homepage/      # client-facing browser UI for personalization (no DB/Redis
│   │   │                  #   needed beyond what the pipeline itself uses)
│   │   └── demo/          # CLI harness + benchmark script + pre-generated QA images
│   └── web/               # Next.js 14 app — /cart, /checkout, /confirmation,
│                           #   /track/[orderId]. No longer deferred/empty.
├── packages/
│   └── shared/            # (still EMPTY placeholder — see its README for why)
├── services/
│   └── faceswap/          # self-hosted swap stage — same model, ~50x faster than
│                           #   the hosted call (which bills 60s of CPU cold start)
├── infra/                 # deployment notes (nothing is deployed yet)
└── assets/
    ├── templates/         # page artwork — 2 illustrator pages + 3 competitor screenshots
    ├── style-refs/        # illustration style reference images from client
    └── test-photos/       # consented QA photos (git-ignored — a fresh clone has none)
```

## Tech stack

Node 20 · TypeScript · Fastify · Prisma + Postgres (Neon) · BullMQ + Redis (Upstash) ·
Cloudflare R2 · `@tensorflow/tfjs` + blazeface (local face detection) · Replicate
(`google/nano-banana` repaint, InsightFace inswapper swap, CodeFormer restore) · Sharp
(local image work + print-PDF color conversion) · Stripe (payments) · PDFKit (print PDF
assembly) · Gelato (print-on-demand dispatch) · Resend (transactional email) · Next.js 14 +
Tailwind v4 (`apps/web` — cart/checkout/confirmation/tracking).

## Getting started

**Want to see the whole thing running at once?** One command boots the API+worker, the
cart/checkout web app, and the personalization homepage together, with labeled/colored
output per process:

```bash
# prerequisites: Node 20 (see .nvmrc)
npm run install:all
cd apps/api && cp .env.example .env    # fill in real credentials — see below
cd ../web && cp .env.local.example .env.local
cd ../..
npm run dev
```

- API: http://localhost:3001 (docs at `/docs`)
- Cart/checkout app: http://localhost:3000
- Personalization homepage: http://127.0.0.1:5174

`apps/api/.env.example` is the authoritative key list for backend credentials — Postgres,
R2, Redis, Replicate for the personalization engine; Stripe/Gelato/Resend for cart/
checkout. **[docs/CART_CHECKOUT_SETUP.md](docs/CART_CHECKOUT_SETUP.md)** walks through
getting real (or test-mode) credentials for the payment/print/email side, with a full
manual walkthrough of the actual user flow.

**Just want the personalization engine, nothing else?** The homepage alone needs only a
Replicate token — no Postgres, no Redis, no storage:

```bash
cd apps/api && npm install
cp .env.example .env         # fill in REPLICATE_API_TOKEN only
npm run homepage             # http://localhost:5174
```

See [docs/DEMO_RUNBOOK.md](docs/DEMO_RUNBOOK.md) — including the pre-generated images in
`apps/api/demo/keep-demo/`, which need no API, network or credit at all.

`apps/api/test/e2e-multichar.mjs` drives the multi-character personalization loop
end-to-end against a running server; `apps/api/test/unit/` (`npm test`) covers the
cart/checkout/print-dispatch layer's pure logic (pricing, order-status transitions,
config snapshotting).

## Status

Personalization engine: built and verified end-to-end, single- and multi-character,
through both the real API and the browser homepage. See `apps/api/README.md`'s "Known
state" for exactly what is verified and the open risks — the licensing one blocks
selling, not building.

Cart/checkout/print-dispatch: built 2026-08-30, and live-verified against real test-mode
infrastructure — see [docs/CART_CHECKOUT_SETUP.md](docs/CART_CHECKOUT_SETUP.md) for exactly
what was proven working (a real Stripe payment through webhook to order-status update; a
real email delivered via Resend; a real request reaching Gelato's order API with the
correct shape) versus what's still pending manual account setup (Gelato billing info,
Resend domain verification, real book page counts).

**The prototype is not deployed** — both `apps/api` and `apps/web` are local-only, with no
shareable demo URL; that remains the one outstanding deliverable for showing this to
someone without them running it locally. `infra/README.md` has target-state hosting notes.

## Scope boundary

**Built:** multi-character upload → per-character pipeline → personalized pages,
documented API; client-facing homepage (`apps/api/homepage/`) for personalization; cart →
Stripe checkout → 300 DPI CMYK print PDF → Gelato print dispatch → order tracking → Resend
confirmation email (`apps/web` + the corresponding `apps/api` routes).

**Deferred:** the full multi-page/multi-theme template library, an automated GDPR
raw-photo-deletion cron (the customer-facing deletion *promise* is built; the job that
enforces it isn't), an admin dashboard, user accounts/auth, full i18n beyond the single
locale. See [PROJECT_PLAN.md §2, §16 & §17](PROJECT_PLAN.md) for the original framing (now
partially superseded) and
[docs/superpowers/specs/2026-08-30-cart-payments-print-dispatch-design.md](docs/superpowers/specs/2026-08-30-cart-payments-print-dispatch-design.md)'s
§9 for what's explicitly out of scope in the cart/checkout layer specifically.

---
Prototype engagement · Owner: Affan Ahmed · Client: _private engagement_

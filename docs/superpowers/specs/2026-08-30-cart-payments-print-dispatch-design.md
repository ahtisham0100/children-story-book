# Phase 2 · Part 1 — Cart, Payments & Print Dispatch

Status: approved for planning
Date: 2026-08-30
Supersedes: nothing. Extends the existing personalization pipeline documented in
`docs/PROTOTYPE_OVERVIEW.md`; does not change `Session`/`Character` or the render
pipeline itself.

## 1. Goal

Take a customer from "I have a rendered preview" to "I paid, a print-ready PDF was
generated, Gelato is printing it, and I can track the order" — with no login
required anywhere in the flow.

## 2. Scope decisions (made during brainstorming — flag if any are wrong)

- **A "book" is a real multi-page book.** The `BOOKS`/`PAGES` registry in
  `apps/api/src/pipeline/catalog.ts` already models this (a `BookConfig` has an
  ordered `pageIds` list; `pagesFor(book, "full")` renders every page). Nothing
  changes there except adding a `priceCents` field per book.
- **Cart is client-side only.** No `Cart`/`CartItem` DB tables. The browser holds
  an array of `sessionId`s (localStorage) plus cached display data fetched from
  `GET /api/sessions/:id` and `GET /api/sessions/:id/pages`. Nothing is written
  server-side until checkout. This is deliberately the smaller of two designs
  considered (server-side cart table vs. client-side array) — an abandoned-cart
  data model wasn't asked for and adds a full CRUD surface for no current
  requirement.
- **"Immutable config versioning" is satisfied by `Session` immutability +
  snapshotting.** A `Session`'s `storyId` and its characters' `slot`/`childName`/
  `rawKey` are set once at creation/upload and never mutated afterward (verified
  by reading `apps/api/src/routes/sessions.ts` — no route updates those fields
  post-upload). "Editing" a book in the cart means creating a brand-new `Session`
  (already-supported `POST /api/sessions`), not mutating the old one. At checkout,
  the exact character config is additionally denormalized onto `OrderItem.configSnapshot`
  so the order is provably pinned even if `Session` mutation rules ever change later.
- **GDPR "photo deletion notice" is copy/timeline, not a new deletion cron.**
  `PROJECT_PLAN.md` §16 already lists "GDPR deletion cron + audit log" as a
  separate deferred item from Resend email. This phase builds the customer-facing
  promise (confirmation page + email copy: "raw photos deleted within 24h of
  order completion" — matching the wording used in the reference site's trust
  section) but not the automated job that performs it. That job is a distinct,
  clearly-labeled follow-up (flagged again in §9 below), not silently bundled in.
- **Print PDF fidelity is bounded by current pipeline output resolution.**
  Rendered pages are ~800×739px; true 300 DPI at a real trim size (e.g. 8×8in =
  2400×2400px) needs higher-res source art and pipeline output, which is an
  illustration/pipeline concern, not something this phase's code can fix. The PDF
  assembly step will do the color-space part correctly (RGB→CMYK via `sharp`)
  and embed at the book's configured trim size; visual sharpness at real print
  size is a known, called-out risk, not a silent gap.
- **Gelato product is one configurable SKU** (env var), since no Gelato account/
  catalog exists yet. Real trim size, paper, and page-count-per-product come from
  whatever product the user picks when they set up the Gelato account (§9).

## 3. UI reference

`https://ahtisham0100.github.io/children-story-book-prototype/` — a landing-page
mockup for a similar product ("Imagitale"). Only the hero/catalog/testimonial
sections and an empty cart state are actually built out there; `/checkout`,
`/confirmation`, and `/track` don't exist in that reference, so those are
designed fresh but in the same visual language:

- Palette: warm cream background (`#FAF7F2`-ish), dark-brown text/headers
  (`#3D2B1F`-ish), green pill CTA buttons, soft gold/orange accent
  (icon color, underline highlight on hero text).
- Typography: serif display face ("Playfair Display" or closest equivalent) for
  headings, clean sans body text.
- Components: heavily rounded cards, badge/tag chips for metadata (age range,
  category, page count), a dedicated trust/GDPR section with icon + short promise
  copy per row — reuse this pattern verbatim for the GDPR deletion notice on
  `/confirmation`.
- Book catalog cards show: age range, title, price, category tags, page count —
  the same fields `/cart` line items should show per book.

Full visual polish (exact spacing, responsive behavior, component structure) is
an implementation-time concern for `frontend-design`, not re-litigated here.

## 4. Data model (new; `Session`/`Character` untouched)

```prisma
model Order {
  id                    String   @id @default(uuid())
  email                 String
  shippingName          String
  shippingLine1         String
  shippingLine2         String?
  shippingCity          String
  shippingPostalCode    String
  shippingCountry       String
  status                String   @default("awaiting_payment")
  // awaiting_payment | paid | pdf_ready | submitted_to_print |
  // processing | dispatched | delivered | failed | cancelled
  stripePaymentIntentId String?  @unique
  totalCents            Int
  currency              String   @default("eur")
  gdprConsentAt         DateTime
  gelatoOrderId         String?
  createdAt             DateTime @default(now())
  updatedAt             DateTime @updatedAt
  items                 OrderItem[]
  statusEvents          OrderStatusEvent[]
}

model OrderItem {
  id               String  @id @default(uuid())
  orderId          String
  order            Order   @relation(fields: [orderId], references: [id])
  sessionId        String
  storyId          String
  bookTitle        String
  priceCents       Int
  configSnapshot   Json    // [{slot, childName, rawKey}]
  printPageKeys    Json    // R2 keys of the rendered pages used, in order
  printPdfKey      String? // this item's own assembled print PDF — one per
                           // book, not one per order, since Gelato's order-
                           // create API takes multiple line items each with
                           // their own file (a 2-book cart ships as one
                           // Gelato order with 2 items, 2 files)
}

model OrderStatusEvent {
  id        String   @id @default(uuid())
  orderId   String
  order     Order    @relation(fields: [orderId], references: [id])
  status    String
  source    String   // stripe_webhook | gelato_webhook | system
  raw       Json?
  createdAt DateTime @default(now())
}
```

`catalog.ts` gains `priceCents: number` on `BookConfig`.

## 5. Backend flow

1. **`POST /api/checkout`** — body `{ sessionIds: string[], email, shippingAddress,
   gdprConsent: true }`. For each `sessionId`: loads the `Session` + `Character`s,
   confirms every character has `rawKey` and the book's pages are fully rendered
   (calls the existing render-full path if not — reuses `getPipelineQueue()`/
   `render-full` logic already in `sessions.ts`, doesn't duplicate it). Computes
   `totalCents` from `catalog.ts` prices. Creates `Order` (status
   `awaiting_payment`) + one `OrderItem` per session with `configSnapshot` taken
   from the DB at this exact moment. Creates a Stripe `PaymentIntent` for the
   total and returns `{ orderId, clientSecret }`.
2. **`POST /api/webhooks/stripe`** — verifies the Stripe signature. On
   `payment_intent.succeeded`, idempotently (only if `Order.status ===
   "awaiting_payment"`) sets status `paid`, appends an `OrderStatusEvent`, and
   triggers PDF assembly (fire-and-forget, same pattern as the existing BullMQ
   enqueue-then-return style).
3. **PDF assembly (`src/print/assemble.ts`)** — per `OrderItem`, pulls each
   rendered page PNG from R2 (`pageObjectKey`), converts to a CMYK JPEG via
   `sharp().toColourspace("cmyk")` sized for the book's configured trim size,
   assembles into one PDFKit document per item, uploads to R2, sets that item's
   `printPdfKey`. Once every item has one, order status → `pdf_ready`.
4. **Gelato dispatch (`src/print/gelato.ts`)** — one Gelato order carrying one
   line item per `OrderItem` (its own `printPdfKey` as the file, its own
   product UID), shipping address from the `Order`. Stores `gelatoOrderId`,
   status → `submitted_to_print`. Sends the Resend confirmation email at this
   point (order ID, book summary, estimated delivery, GDPR deletion timeline
   copy).
5. **`POST /api/webhooks/gelato`** — receives Gelato status callbacks, appends an
   `OrderStatusEvent` with the raw payload, maps Gelato's vocabulary onto
   `processing`/`dispatched`/`delivered`.
6. **`GET /api/orders/:id`** — public (the order ID is the capability token, same
   trust model as the reference site's no-login tracking). Returns order +
   status-event timeline for `/track/[orderId]`.

## 6. Frontend (`apps/web` — Next.js 14 App Router + Tailwind; currently empty)

- **`/cart`** — reads the localStorage session-id list, fetches each session's
  title/pages/price, shows removable line items + "add another book" (links back
  into the existing session-creation flow), totals, proceeds to `/checkout`.
- **`/checkout`** — one page: delivery address form, GDPR consent checkbox,
  embedded Stripe Payment Element. On submit: `POST /api/checkout` → confirm the
  PaymentIntent client-side with Stripe.js → on success, navigate to
  `/confirmation?order=<id>`.
- **`/confirmation`** — receipt (items, total), order ID, GDPR deletion timeline
  copy (styled like the reference site's trust section), link to `/track/[id]`.
- **`/track/[orderId]`** — calls `GET /api/orders/:id`, renders the status
  timeline from `OrderStatusEvent`s.

## 7. Testing

No test runner exists yet in `apps/api` (only `typecheck`). Add Vitest, scoped to
pure logic that's worth unit-testing without live Stripe/Gelato calls:

- Price computation from cart contents.
- Gelato-status → canonical-status mapping.
- Config-snapshot correctness (given a `Session`, the snapshot matches).
- Webhook idempotency (`payment_intent.succeeded` processed twice → one status
  transition, not two).

Signature verification and the real Stripe/Gelato/Resend calls are exercised
manually against test-mode keys per the checklist below — not mocked in CI.

## 8. Environment variables (new, `apps/api/.env.example`)

`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PUBLISHABLE_KEY` (frontend),
`GELATO_API_KEY`, `GELATO_PRODUCT_UID`, `GELATO_WEBHOOK_SECRET` (if Gelato
supports one), `RESEND_API_KEY`, `RESEND_FROM_ADDRESS`.

## 9. Explicitly out of scope for this part

- The automated GDPR raw-photo deletion cron (notice/copy only, per §2).
- Any account/auth system (order tracking is ID-based, no login, per the
  original spec bullets).
- Choosing the real Gelato product/trim size — that's a manual account-setup
  step, not code (see the post-build checklist delivered alongside the plan).
- Fixing pipeline output resolution for true 300 DPI print fidelity.

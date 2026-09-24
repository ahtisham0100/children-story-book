# Cart, Payments & Print Dispatch — Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `apps/api` backend for cart checkout, Stripe payment, print-PDF
assembly, Gelato dispatch, order-status tracking, and Resend email — everything
behind `POST /api/checkout` through `GET /api/orders/:id`.

**Architecture:** New `Order`/`OrderItem`/`OrderStatusEvent` Prisma models sit
alongside the existing `Session`/`Character` models untouched. Checkout creates
an `Order` and a Stripe `PaymentIntent`; a Stripe webhook marks it paid and
fires an async fulfillment pipeline (enqueue full-book render via the existing
`Queue`/BullMQ path → assemble a per-book CMYK PDF → dispatch to Gelato → send
a Resend confirmation email); a Gelato webhook appends status events for
`/api/orders/:id` to report.

**Tech Stack:** Fastify 5 + TypeBox (existing), Prisma/Postgres (existing),
BullMQ/Redis (existing), R2/`sharp` (existing), new: `stripe`, `pdfkit`,
`resend`, `vitest`.

**Spec:** [docs/superpowers/specs/2026-08-30-cart-payments-print-dispatch-design.md](../specs/2026-08-30-cart-payments-print-dispatch-design.md)

## Global Constraints

- No server-side cart table — cart is client-side (frontend plan's concern);
  this plan starts at `POST /api/checkout`.
- `Session`/`Character` are never mutated by any code in this plan — read-only.
- Checkout must NOT trigger any paid render. Full-book rendering is triggered
  only after Stripe confirms payment (see [[api-cost-discipline]] rationale
  reproduced in the spec's §2 — the existing `render-full` route comment says
  it's "run after purchase").
- Every dollar amount is an integer count of cents (`priceCents`, `totalCents`) —
  never a float.
- GDPR deletion is a copy/notice concern in this plan (confirmation email
  wording), not a working deletion job — that is explicitly out of scope (spec §9).
- Signature verification and real Stripe/Gelato/Resend calls are exercised
  manually against test-mode keys (checklist delivered separately), not mocked
  in CI — only pure logic gets an automated Vitest test.

---

### Task 1: Prisma schema — `Order`, `OrderItem`, `OrderStatusEvent`

**Files:**
- Modify: `apps/api/prisma/schema.prisma`

**Interfaces:**
- Produces: Prisma Client types `Order`, `OrderItem`, `OrderStatusEvent`, and
  the enums-as-strings used throughout this plan: order status values
  `"awaiting_payment" | "paid" | "pdf_ready" | "submitted_to_print" |
  "processing" | "dispatched" | "delivered" | "failed" | "cancelled"`; event
  source values `"stripe_webhook" | "gelato_webhook" | "system"`.

- [ ] **Step 1: Add the three models**

Append to `apps/api/prisma/schema.prisma` (after the existing `Character` model):

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
  id             String  @id @default(uuid())
  orderId        String
  order          Order   @relation(fields: [orderId], references: [id])
  sessionId      String
  storyId        String
  bookTitle      String
  priceCents     Int
  configSnapshot Json
  printPageKeys  Json
  printPdfKey    String?
}

model OrderStatusEvent {
  id        String   @id @default(uuid())
  orderId   String
  order     Order    @relation(fields: [orderId], references: [id])
  status    String
  source    String
  raw       Json?
  createdAt DateTime @default(now())
}
```

- [ ] **Step 2: Generate and apply the migration**

Run: `cd apps/api && npm run prisma:migrate -- --name add_orders`

Expected: prompts complete, a new folder appears under `apps/api/prisma/migrations/`
whose name ends in `_add_orders`, and the command exits 0. This also runs
`prisma generate`, refreshing the `@prisma/client` types.

- [ ] **Step 3: Typecheck**

Run: `cd apps/api && npm run typecheck`
Expected: exits 0 (the new models aren't imported anywhere yet, so this just
confirms the schema change didn't break generation).

- [ ] **Step 4: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations
git commit -m "feat(db): add Order, OrderItem, OrderStatusEvent models"
```

---

### Task 2: Vitest setup + book pricing

**Files:**
- Modify: `apps/api/package.json`
- Create: `apps/api/vitest.config.ts`
- Modify: `apps/api/tsconfig.json`
- Modify: `apps/api/src/pipeline/catalog.ts`
- Create: `apps/api/src/pricing.ts`
- Test: `apps/api/test/unit/pricing.test.ts`

**Interfaces:**
- Consumes: `BOOKS`, `BookConfig`, `getBook` from `./pipeline/catalog` (existing,
  read in Task 1's context above at `apps/api/src/pipeline/catalog.ts`).
- Produces: `priceCentsForBook(storyId: string): number` and
  `computeTotalCents(storyIds: string[]): { totalCents: number; currency: "eur" }`
  from `src/pricing.ts` — used by Task 8 (checkout route).

- [ ] **Step 1: Install Vitest and the new runtime dependencies**

Run:
```bash
cd apps/api
npm install -D vitest
npm install stripe pdfkit resend
npm install -D @types/pdfkit
```

- [ ] **Step 2: Add the `vitest.config.ts`**

Create `apps/api/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts"],
  },
});
```

- [ ] **Step 3: Add the `test` script and include `test/` in `tsconfig.json`**

In `apps/api/package.json`, add to `"scripts"`:
```json
"test": "vitest run"
```

In `apps/api/tsconfig.json`, change:
```json
"include": ["src", "demo", "homepage", "homepage_local"],
```
to:
```json
"include": ["src", "demo", "homepage", "homepage_local", "test"],
```

- [ ] **Step 4: Add `priceCents` to `BookConfig` and each book**

In `apps/api/src/pipeline/catalog.ts`, change the `BookConfig` interface:

```ts
export interface BookConfig {
  title: string;
  /** Page ids, in reading order. */
  pageIds: string[];
  /** Retail price in cents. Integer, never a float — avoids rounding bugs. */
  priceCents: number;
}
```

And add `priceCents` to both entries in `BOOKS`:

```ts
export const BOOKS: Record<string, BookConfig> = {
  "demo-book": {
    title: "Demo book — one child",
    pageIds: ["workshop", "astronaut", "plane"],
    priceCents: 3490,
  },
  "demo-book-duo": {
    title: "Demo book — two children",
    pageIds: ["newtemp", "newtemp2"],
    priceCents: 3490,
  },
};
```

- [ ] **Step 5: Write the failing test**

Create `apps/api/test/unit/pricing.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { priceCentsForBook, computeTotalCents } from "../../src/pricing";

describe("priceCentsForBook", () => {
  it("returns the configured price for a known book", () => {
    expect(priceCentsForBook("demo-book")).toBe(3490);
  });

  it("throws for an unknown storyId", () => {
    expect(() => priceCentsForBook("no-such-book")).toThrow();
  });
});

describe("computeTotalCents", () => {
  it("sums prices across multiple books", () => {
    const result = computeTotalCents(["demo-book", "demo-book-duo"]);
    expect(result.totalCents).toBe(6980);
    expect(result.currency).toBe("eur");
  });

  it("returns zero for an empty cart", () => {
    expect(computeTotalCents([]).totalCents).toBe(0);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd apps/api && npm test`
Expected: FAIL — `Cannot find module '../../src/pricing'` (file doesn't exist yet).

- [ ] **Step 7: Implement `src/pricing.ts`**

```ts
import { getBook } from "./pipeline/catalog";

/** Retail price of one book, in cents. Throws if storyId is unknown. */
export function priceCentsForBook(storyId: string): number {
  return getBook(storyId).priceCents;
}

/** Sums book prices for a cart's list of storyIds. Single currency (eur) for now. */
export function computeTotalCents(storyIds: string[]): { totalCents: number; currency: "eur" } {
  const totalCents = storyIds.reduce((sum, storyId) => sum + priceCentsForBook(storyId), 0);
  return { totalCents, currency: "eur" };
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `cd apps/api && npm test`
Expected: PASS (4 tests).

- [ ] **Step 9: Typecheck**

Run: `cd apps/api && npm run typecheck`
Expected: exits 0.

- [ ] **Step 10: Commit**

```bash
git add apps/api/package.json apps/api/package-lock.json apps/api/vitest.config.ts \
  apps/api/tsconfig.json apps/api/src/pipeline/catalog.ts apps/api/src/pricing.ts \
  apps/api/test/unit/pricing.test.ts
git commit -m "feat: add Vitest, book pricing, and new print/payment dependencies"
```

---

### Task 3: Order status state machine

**Files:**
- Create: `apps/api/src/orderStatus.ts`
- Test: `apps/api/test/unit/orderStatus.test.ts`

**Interfaces:**
- Produces: `type OrderStatus` (the 9-value union from Task 1), `ORDER_STATUS`
  (an object of status constants for readability at call sites),
  `canTransitionToPaid(current: OrderStatus): boolean`,
  `mapGelatoStatus(gelatoStatus: string): OrderStatus | null` — used by Task 12
  (webhooks route).

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/unit/orderStatus.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { canTransitionToPaid, mapGelatoStatus, ORDER_STATUS } from "../../src/orderStatus";

describe("canTransitionToPaid", () => {
  it("allows the transition from awaiting_payment", () => {
    expect(canTransitionToPaid(ORDER_STATUS.awaitingPayment)).toBe(true);
  });

  it("rejects a second payment_intent.succeeded delivery (idempotency)", () => {
    expect(canTransitionToPaid(ORDER_STATUS.paid)).toBe(false);
    expect(canTransitionToPaid(ORDER_STATUS.dispatched)).toBe(false);
  });
});

describe("mapGelatoStatus", () => {
  it("maps known Gelato statuses to canonical order statuses", () => {
    expect(mapGelatoStatus("printed")).toBe(ORDER_STATUS.processing);
    expect(mapGelatoStatus("shipped")).toBe(ORDER_STATUS.dispatched);
    expect(mapGelatoStatus("delivered")).toBe(ORDER_STATUS.delivered);
  });

  it("returns null for an unrecognized status instead of guessing", () => {
    expect(mapGelatoStatus("some_future_gelato_status")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npm test`
Expected: FAIL — `Cannot find module '../../src/orderStatus'`.

- [ ] **Step 3: Implement `src/orderStatus.ts`**

```ts
export const ORDER_STATUS = {
  awaitingPayment: "awaiting_payment",
  paid: "paid",
  pdfReady: "pdf_ready",
  submittedToPrint: "submitted_to_print",
  processing: "processing",
  dispatched: "dispatched",
  delivered: "delivered",
  failed: "failed",
  cancelled: "cancelled",
} as const;

export type OrderStatus = (typeof ORDER_STATUS)[keyof typeof ORDER_STATUS];

/**
 * Stripe redelivers webhooks (at-least-once delivery), so payment_intent.succeeded
 * can arrive more than once for the same order. Only the FIRST delivery should
 * move the order forward — everything after that is a no-op, not an error.
 */
export function canTransitionToPaid(current: OrderStatus): boolean {
  return current === ORDER_STATUS.awaitingPayment;
}

/**
 * Gelato's own status vocabulary, mapped onto ours. Returns null (rather than
 * throwing or guessing) for anything unrecognized, so a webhook route can log
 * and store the raw event without corrupting order.status.
 *
 * NOTE: written from Gelato's commonly-documented order-status vocabulary.
 * Confirm the exact strings their webhook actually sends against a real
 * test-mode order once API access exists (see the post-build checklist) and
 * extend this map if any are missing.
 */
const GELATO_STATUS_MAP: Record<string, OrderStatus> = {
  created: ORDER_STATUS.submittedToPrint,
  in_production: ORDER_STATUS.processing,
  printed: ORDER_STATUS.processing,
  shipped: ORDER_STATUS.dispatched,
  delivered: ORDER_STATUS.delivered,
  cancelled: ORDER_STATUS.cancelled,
  failed: ORDER_STATUS.failed,
};

export function mapGelatoStatus(gelatoStatus: string): OrderStatus | null {
  return GELATO_STATUS_MAP[gelatoStatus] ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npm test`
Expected: PASS (4 tests in this file, 8 total).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/orderStatus.ts apps/api/test/unit/orderStatus.test.ts
git commit -m "feat: add order status state machine and Gelato status mapping"
```

---

### Task 4: Config snapshot + print page keys

**Files:**
- Create: `apps/api/src/orderSnapshot.ts`
- Test: `apps/api/test/unit/orderSnapshot.test.ts`

**Interfaces:**
- Consumes: `Character` shape `{ slot: string; childName: string; rawKey: string | null }`
  (matches the Prisma `Character` model), `bookPages`, `pageObjectKey`,
  `BookConfig` from `./pipeline/catalog`.
- Produces: `buildConfigSnapshot(characters): ConfigSnapshotEntry[]` (throws if
  any character has no `rawKey`), `buildPrintPageKeys(sessionId, book):
  string[]` — both used by Task 8 (checkout route).

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/unit/orderSnapshot.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildConfigSnapshot, buildPrintPageKeys } from "../../src/orderSnapshot";
import type { BookConfig } from "../../src/pipeline/catalog";

describe("buildConfigSnapshot", () => {
  it("snapshots slot, childName, and rawKey for each character", () => {
    const snapshot = buildConfigSnapshot([
      { slot: "child_1", childName: "Amina", rawKey: "sessions/abc/characters/1/raw.jpg" },
    ]);
    expect(snapshot).toEqual([
      { slot: "child_1", childName: "Amina", rawKey: "sessions/abc/characters/1/raw.jpg" },
    ]);
  });

  it("throws if any character has no uploaded photo yet", () => {
    expect(() =>
      buildConfigSnapshot([{ slot: "child_1", childName: "Amina", rawKey: null }]),
    ).toThrow();
  });
});

describe("buildPrintPageKeys", () => {
  it("derives one R2 key per page, in reading order", () => {
    const book: BookConfig = { title: "t", priceCents: 100, pageIds: ["workshop", "astronaut"] };
    expect(buildPrintPageKeys("session-1", book)).toEqual([
      "sessions/session-1/pages/workshop.png",
      "sessions/session-1/pages/astronaut.png",
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npm test`
Expected: FAIL — `Cannot find module '../../src/orderSnapshot'`.

- [ ] **Step 3: Implement `src/orderSnapshot.ts`**

```ts
import { bookPages, pageObjectKey, type BookConfig } from "./pipeline/catalog";

export interface ConfigSnapshotEntry {
  slot: string;
  childName: string;
  rawKey: string;
}

interface CharacterLike {
  slot: string;
  childName: string;
  rawKey: string | null;
}

/**
 * Denormalizes a session's characters onto an OrderItem at checkout time, so
 * the order stays provably pinned to what was previewed even if Session rules
 * ever changed later. Throws if any character hasn't uploaded a photo — the
 * caller (checkout route) is expected to have already checked this and turned
 * it into a 409, so this throw is a defensive backstop, not the primary check.
 */
export function buildConfigSnapshot(characters: CharacterLike[]): ConfigSnapshotEntry[] {
  return characters.map((c) => {
    if (!c.rawKey) {
      throw new Error(`Character in slot "${c.slot}" has no uploaded photo — cannot snapshot.`);
    }
    return { slot: c.slot, childName: c.childName, rawKey: c.rawKey };
  });
}

/** The R2 keys every page of a book will land at once fully rendered, in reading order. */
export function buildPrintPageKeys(sessionId: string, book: BookConfig): string[] {
  return bookPages(book).map((page) => pageObjectKey(sessionId, page.id));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npm test`
Expected: PASS (3 tests in this file, 11 total).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/orderSnapshot.ts apps/api/test/unit/orderSnapshot.test.ts
git commit -m "feat: add order config snapshot and print page key derivation"
```

---

### Task 5: Environment variables for Stripe, Gelato, Resend

**Files:**
- Modify: `apps/api/src/env.ts`
- Modify: `apps/api/.env.example`

**Interfaces:**
- Produces: `env.STRIPE_SECRET_KEY`, `env.STRIPE_WEBHOOK_SECRET`,
  `env.GELATO_API_KEY`, `env.GELATO_PRODUCT_UID`, `env.GELATO_WEBHOOK_SECRET`,
  `env.RESEND_API_KEY`, `env.RESEND_FROM_ADDRESS`, `env.PRINT_TRIM_WIDTH_IN`,
  `env.PRINT_TRIM_HEIGHT_IN` — consumed by Tasks 6, 7, 8, 9.

- [ ] **Step 1: Add the new keys to `env.ts`**

In `apps/api/src/env.ts`, add inside the `env` object (after `STAGE_EXECUTION`):

```ts
  STRIPE_SECRET_KEY: readOptional("STRIPE_SECRET_KEY"),
  STRIPE_WEBHOOK_SECRET: readOptional("STRIPE_WEBHOOK_SECRET"),
  GELATO_API_KEY: readOptional("GELATO_API_KEY"),
  GELATO_PRODUCT_UID: readOptional("GELATO_PRODUCT_UID"),
  // Optional: only set if Gelato's dashboard offers a webhook signing secret
  // for your account. If unset, the Gelato webhook route accepts unsigned
  // requests — acceptable for now since GELATO_API_KEY-gated status is a low-
  // value target, but tighten this before relying on it for anything financial.
  GELATO_WEBHOOK_SECRET: readOptional("GELATO_WEBHOOK_SECRET"),
  RESEND_API_KEY: readOptional("RESEND_API_KEY"),
  RESEND_FROM_ADDRESS: readOptional("RESEND_FROM_ADDRESS") ?? "orders@example.com",
  // Print trim size in inches. 8.5x8.5 is a common square kids-book size;
  // override once you've picked a real Gelato product.
  PRINT_TRIM_WIDTH_IN: Number(readOptional("PRINT_TRIM_WIDTH_IN") ?? "8.5"),
  PRINT_TRIM_HEIGHT_IN: Number(readOptional("PRINT_TRIM_HEIGHT_IN") ?? "8.5"),
```

- [ ] **Step 2: Document the new keys in `.env.example`**

Append to `apps/api/.env.example`:

```
# --- Stripe (test-mode keys until you're ready to go live) ---
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=

# --- Gelato print dispatch ---
GELATO_API_KEY=
GELATO_PRODUCT_UID=
GELATO_WEBHOOK_SECRET=

# --- Resend transactional email ---
RESEND_API_KEY=
RESEND_FROM_ADDRESS=orders@yourdomain.com

# --- Print PDF trim size, in inches ---
PRINT_TRIM_WIDTH_IN=8.5
PRINT_TRIM_HEIGHT_IN=8.5
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/api && npm run typecheck`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/env.ts apps/api/.env.example
git commit -m "feat: add Stripe/Gelato/Resend/print-size environment variables"
```

---

### Task 6: Stripe client

**Files:**
- Create: `apps/api/src/stripeClient.ts`

**Interfaces:**
- Consumes: `env.STRIPE_SECRET_KEY` (Task 5).
- Produces: `stripe` (a configured `Stripe` client instance) — used by Tasks 8
  and 12.

- [ ] **Step 1: Implement `src/stripeClient.ts`**

```ts
import Stripe from "stripe";
import { env } from "./env";

// Unlike this codebase's other credential fallbacks (db.ts's placeholder URL,
// storage.ts's empty-string R2 keys), the Stripe SDK THROWS at construction
// time if given an empty string — an empty-string fallback here would crash
// the entire server at boot, not just Stripe calls, whenever
// STRIPE_SECRET_KEY is unset. A placeholder string satisfies the
// constructor's "something was provided" check without making any network
// call — real calls still fail clearly, just at call time instead of import time.
export const stripe = new Stripe(env.STRIPE_SECRET_KEY ?? "sk_test_unconfigured");
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/api && npm run typecheck`
Expected: exits 0. If TypeScript reports a missing required `apiVersion` field
on the config object, check the installed `stripe` package's `Stripe.StripeConfig`
type (`node_modules/stripe/types/lib.d.ts`) for the exact literal it expects and
pass it explicitly — recent `stripe` versions make this optional, but pin it
here if your installed version disagrees.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/stripeClient.ts
git commit -m "feat: add Stripe client"
```

---

### Task 7: Print PDF assembly

**Files:**
- Create: `apps/api/src/print/assemble.ts`

**Interfaces:**
- Consumes: `getObjectBuffer`, `putObject` from `../storage` (existing);
  `env.PRINT_TRIM_WIDTH_IN`, `env.PRINT_TRIM_HEIGHT_IN` (Task 5).
- Produces: `assembleItemPdf(orderId: string, item: { id: string;
  printPageKeys: string[] }): Promise<{ key: string }>` — used by Task 10
  (fulfillment orchestration).

- [ ] **Step 1: Implement `src/print/assemble.ts`**

```ts
import PDFDocument from "pdfkit";
import { PassThrough } from "node:stream";
import sharp from "sharp";
import { getObjectBuffer, putObject } from "../storage";
import { env } from "../env";

const POINTS_PER_INCH = 72;
// 300 DPI at the configured trim size — see env.ts for the caveat that actual
// sharpness is bounded by the pipeline's current render resolution (~800x739px),
// not by anything in this file. This file does the color-space part correctly
// regardless: RGB PNG -> CMYK JPEG -> embedded in a CMYK-safe PDF.
const DPI = 300;

function pageSizePoints(): { width: number; height: number } {
  return {
    width: env.PRINT_TRIM_WIDTH_IN * POINTS_PER_INCH,
    height: env.PRINT_TRIM_HEIGHT_IN * POINTS_PER_INCH,
  };
}

function pageSizePixels(): { width: number; height: number } {
  return {
    width: Math.round(env.PRINT_TRIM_WIDTH_IN * DPI),
    height: Math.round(env.PRINT_TRIM_HEIGHT_IN * DPI),
  };
}

/**
 * Converts one rendered page (RGB PNG) to a print-ready CMYK JPEG at the
 * configured trim size. `.toColourspace("cmyk")` before `.jpeg()` is what makes
 * the output an actual CMYK JPEG (with the Adobe APP14 marker readers use to
 * tell it apart from RGB) rather than an RGB JPEG that merely claims to be
 * print-ready.
 */
export async function renderPageToCmykJpeg(pngBuffer: Buffer): Promise<Buffer> {
  const { width, height } = pageSizePixels();
  return sharp(pngBuffer)
    .resize(width, height, { fit: "cover" })
    .flatten({ background: "#ffffff" })
    .toColourspace("cmyk")
    .jpeg({ quality: 95 })
    .toBuffer();
}

function assemblePdfBuffer(cmykJpegPages: Buffer[]): Promise<Buffer> {
  const { width, height } = pageSizePoints();
  const doc = new PDFDocument({ size: [width, height], margin: 0, autoFirstPage: false });
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
  doc.pipe(stream);
  for (const jpeg of cmykJpegPages) {
    doc.addPage({ size: [width, height], margin: 0 });
    doc.image(jpeg, 0, 0, { width, height });
  }
  doc.end();
  return done;
}

export const printPdfObjectKey = (orderId: string, orderItemId: string): string =>
  `orders/${orderId}/items/${orderItemId}/print.pdf`;

/** Pulls every rendered page for one OrderItem, converts, assembles, uploads. */
export async function assembleItemPdf(
  orderId: string,
  item: { id: string; printPageKeys: string[] },
): Promise<{ key: string }> {
  const pngBuffers = await Promise.all(item.printPageKeys.map((key) => getObjectBuffer(key)));
  const cmykPages = await Promise.all(pngBuffers.map((buf) => renderPageToCmykJpeg(buf)));
  const pdfBuffer = await assemblePdfBuffer(cmykPages);
  const key = printPdfObjectKey(orderId, item.id);
  await putObject(key, pdfBuffer, "application/pdf");
  return { key };
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/api && npm run typecheck`
Expected: exits 0.

- [ ] **Step 3: Manual verification (no automated test — needs a real rendered page)**

This needs an actual rendered page PNG in R2, which needs a real session run
through the pipeline (costs money — see [[api-cost-discipline]]). Defer this
verification to Task 11's end-to-end manual run, where a real checkout
naturally produces one. Don't spend a render here just to test this file in
isolation.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/print/assemble.ts
git commit -m "feat: add print PDF assembly (RGB->CMYK page conversion + PDFKit)"
```

---

### Task 8: Gelato dispatch

**Files:**
- Create: `apps/api/src/print/gelato.ts`

**Interfaces:**
- Consumes: `createDownloadUrl` from `../storage` (existing); `env.GELATO_API_KEY`,
  `env.GELATO_PRODUCT_UID` (Task 5).
- Produces: `submitOrderToGelato(order): Promise<{ gelatoOrderId: string }>` —
  used by Task 10 (fulfillment orchestration). `order` shape:
  `{ id: string; shippingName: string; shippingLine1: string; shippingLine2:
  string | null; shippingCity: string; shippingPostalCode: string;
  shippingCountry: string; items: { id: string; bookTitle: string;
  printPdfKey: string }[] }`.

- [ ] **Step 1: Implement `src/print/gelato.ts`**

```ts
import { createDownloadUrl } from "../storage";
import { env } from "../env";

interface GelatoOrderInput {
  id: string;
  shippingName: string;
  shippingLine1: string;
  shippingLine2: string | null;
  shippingCity: string;
  shippingPostalCode: string;
  shippingCountry: string;
  items: { id: string; bookTitle: string; printPdfKey: string }[];
}

// WRITTEN FROM GELATO'S COMMONLY-DOCUMENTED v4 ORDER-CREATE API SHAPE. There is
// no Gelato account to verify this against yet (see the post-build checklist).
// Once you have API credentials, place one real test order and diff the actual
// required/returned fields against this function before relying on it —
// treat the URL, field names, and response shape below as a strong starting
// point, not a confirmed contract.
const GELATO_ORDERS_URL = "https://order.gelatoapis.com/v4/orders";

export async function submitOrderToGelato(order: GelatoOrderInput): Promise<{ gelatoOrderId: string }> {
  const items = await Promise.all(
    order.items.map(async (item) => ({
      itemReferenceId: item.id,
      productUid: env.GELATO_PRODUCT_UID,
      files: [{ type: "default", url: await createDownloadUrl(item.printPdfKey, 3600) }],
      quantity: 1,
    })),
  );

  const response = await fetch(GELATO_ORDERS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": env.GELATO_API_KEY ?? "",
    },
    body: JSON.stringify({
      orderReferenceId: order.id,
      currency: "EUR",
      items,
      shippingAddress: {
        firstName: order.shippingName,
        addressLine1: order.shippingLine1,
        addressLine2: order.shippingLine2 ?? undefined,
        city: order.shippingCity,
        postCode: order.shippingPostalCode,
        country: order.shippingCountry,
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Gelato order create failed: ${response.status} ${body}`);
  }

  const data = (await response.json()) as { id?: string; orderId?: string };
  const gelatoOrderId = data.id ?? data.orderId;
  if (!gelatoOrderId) {
    throw new Error(`Gelato order create response had no id/orderId field: ${JSON.stringify(data)}`);
  }
  return { gelatoOrderId };
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/api && npm run typecheck`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/print/gelato.ts
git commit -m "feat: add Gelato order dispatch"
```

---

### Task 9: Resend order confirmation email

**Files:**
- Create: `apps/api/src/email/orderConfirmation.ts`

**Interfaces:**
- Consumes: `env.RESEND_API_KEY`, `env.RESEND_FROM_ADDRESS` (Task 5).
- Produces: `sendOrderConfirmationEmail(order): Promise<void>` — used by Task 10.
  `order` shape: `{ id: string; email: string; totalCents: number; currency:
  string; items: { bookTitle: string }[] }`.

- [ ] **Step 1: Implement `src/email/orderConfirmation.ts`**

```ts
import { Resend } from "resend";
import { env } from "../env";

// Same construction-time-throw issue as stripeClient.ts: Resend's constructor
// throws on an empty/missing key rather than deferring to call time, so an
// empty-string fallback would crash the whole server at boot.
const resend = new Resend(env.RESEND_API_KEY ?? "re_unconfigured");

// Matches the promise made in the /confirmation page and the reference site's
// own trust-section wording. Keep these two copies in sync if either changes —
// see the frontend plan's confirmation page task.
const GDPR_DELETION_NOTICE =
  "Your uploaded photos are automatically deleted within 24 hours of your order being marked delivered.";

interface OrderForEmail {
  id: string;
  email: string;
  totalCents: number;
  currency: string;
  items: { bookTitle: string }[];
}

function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat("en", { style: "currency", currency }).format(cents / 100);
}

export async function sendOrderConfirmationEmail(order: OrderForEmail): Promise<void> {
  const bookList = order.items.map((item) => `- ${item.bookTitle}`).join("\n");
  const total = formatMoney(order.totalCents, order.currency);

  await resend.emails.send({
    from: env.RESEND_FROM_ADDRESS,
    to: order.email,
    subject: `Your order ${order.id} is confirmed`,
    text:
      `Thank you for your order!\n\n` +
      `Order ID: ${order.id}\n` +
      `Books:\n${bookList}\n` +
      `Total: ${total}\n\n` +
      `Estimated delivery: 7-10 business days after printing.\n\n` +
      `${GDPR_DELETION_NOTICE}\n\n` +
      `Track your order any time at /track/${order.id} — no login required.`,
  });
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/api && npm run typecheck`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/email/orderConfirmation.ts
git commit -m "feat: add Resend order confirmation email"
```

---

### Task 10: Fulfillment orchestration

**Files:**
- Create: `apps/api/src/fulfillment.ts`
- Modify: `apps/api/src/queue.ts`

**Interfaces:**
- Consumes: `getPipelineQueue` (existing, extended below with
  `getPipelineQueueEvents`), `prisma` from `./db`, `assembleItemPdf` (Task 7),
  `submitOrderToGelato` (Task 8), `sendOrderConfirmationEmail` (Task 9),
  `ORDER_STATUS` (Task 3).
- Produces: `runFulfillment(orderId: string): Promise<void>` — called
  fire-and-forget by Task 12's Stripe webhook handler after marking an order
  paid.

- [ ] **Step 1: Add a shared `QueueEvents` getter to `queue.ts`**

In `apps/api/src/queue.ts`, replace the two existing import lines:

```ts
import { Queue } from "bullmq";
import { createQueueRedisConnection } from "./redis";
```

with:

```ts
import { Queue, QueueEvents } from "bullmq";
import { createQueueRedisConnection, createRedisConnection } from "./redis";
```

(mirroring `pipeline/queueStageRunner.ts`'s existing per-stage pattern, applied
to the one pipeline queue), and append at the end of the file:

```ts
let queueEventsSingleton: QueueEvents | undefined;

export function getPipelineQueueEvents(): QueueEvents {
  queueEventsSingleton ??= new QueueEvents(PIPELINE_QUEUE_NAME, {
    connection: createRedisConnection(),
  });
  return queueEventsSingleton;
}
```

- [ ] **Step 2: Implement `src/fulfillment.ts`**

```ts
import { prisma } from "./db";
import { getPipelineQueue, getPipelineQueueEvents } from "./queue";
import { assembleItemPdf } from "./print/assemble";
import { submitOrderToGelato } from "./print/gelato";
import { sendOrderConfirmationEmail } from "./email/orderConfirmation";
import { ORDER_STATUS } from "./orderStatus";

// A full book can have several pages, each up to a few minutes (see
// pipeline/catalog.ts's estimateSeconds); generous but bounded so a genuinely
// stuck render surfaces as a failed order instead of hanging forever.
const FULL_RENDER_TIMEOUT_MS = 15 * 60_000;

async function appendStatusEvent(
  orderId: string,
  status: string,
  source: "system" | "stripe_webhook" | "gelato_webhook",
  raw?: unknown,
): Promise<void> {
  await prisma.orderStatusEvent.create({
    data: { orderId, status, source, raw: raw === undefined ? undefined : (raw as object) },
  });
}

async function renderEveryItem(items: { sessionId: string }[]): Promise<void> {
  const queue = getPipelineQueue();
  const queueEvents = getPipelineQueueEvents();
  await Promise.all(
    items.map(async ({ sessionId }) => {
      // Same dedup jobId convention as the existing render-full route: if the
      // preview already rendered every page (or a prior fulfillment attempt got
      // partway through), this either no-ops or is deduped by BullMQ itself.
      const job = await queue.add(
        "process",
        { sessionId, mode: "full" },
        { attempts: 1, removeOnComplete: { count: 1000, age: 3600 }, removeOnFail: 100, jobId: `${sessionId}__full` },
      );
      await job.waitUntilFinished(queueEvents, FULL_RENDER_TIMEOUT_MS);
    }),
  );
}

/**
 * Runs after a Stripe webhook marks an order paid. Fire-and-forget from the
 * webhook handler's perspective (it already returned 200 to Stripe) — any
 * failure here marks the order "failed" with an audit event rather than
 * throwing into the void.
 */
export async function runFulfillment(orderId: string): Promise<void> {
  try {
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true } });

    await renderEveryItem(order.items);

    for (const item of order.items) {
      const printPageKeys = item.printPageKeys as string[];
      const { key } = await assembleItemPdf(order.id, { id: item.id, printPageKeys });
      await prisma.orderItem.update({ where: { id: item.id }, data: { printPdfKey: key } });
    }
    await prisma.order.update({ where: { id: order.id }, data: { status: ORDER_STATUS.pdfReady } });
    await appendStatusEvent(order.id, ORDER_STATUS.pdfReady, "system");

    const itemsWithPdf = await prisma.orderItem.findMany({ where: { orderId: order.id } });
    const { gelatoOrderId } = await submitOrderToGelato({
      id: order.id,
      shippingName: order.shippingName,
      shippingLine1: order.shippingLine1,
      shippingLine2: order.shippingLine2,
      shippingCity: order.shippingCity,
      shippingPostalCode: order.shippingPostalCode,
      shippingCountry: order.shippingCountry,
      items: itemsWithPdf.map((i) => ({ id: i.id, bookTitle: i.bookTitle, printPdfKey: i.printPdfKey! })),
    });
    await prisma.order.update({
      where: { id: order.id },
      data: { status: ORDER_STATUS.submittedToPrint, gelatoOrderId },
    });
    await appendStatusEvent(order.id, ORDER_STATUS.submittedToPrint, "system", { gelatoOrderId });

    await sendOrderConfirmationEmail({
      id: order.id,
      email: order.email,
      totalCents: order.totalCents,
      currency: order.currency,
      items: itemsWithPdf.map((i) => ({ bookTitle: i.bookTitle })),
    });
  } catch (error) {
    console.error(`[fulfillment] order ${orderId} FAILED:`, error);
    await prisma.order.update({ where: { id: orderId }, data: { status: ORDER_STATUS.failed } });
    await appendStatusEvent(orderId, ORDER_STATUS.failed, "system", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/api && npm run typecheck`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/fulfillment.ts apps/api/src/queue.ts
git commit -m "feat: add post-payment fulfillment orchestration"
```

---

### Task 11: `POST /api/checkout`

**Files:**
- Create: `apps/api/src/routes/checkout.ts`
- Modify: `apps/api/src/app.ts`

**Interfaces:**
- Consumes: `prisma`, `env`, `stripe` (Task 6), `computeTotalCents` (Task 2),
  `priceCentsForBook` (Task 2), `buildConfigSnapshot`, `buildPrintPageKeys`
  (Task 4), `getBook` from `./pipeline/catalog`.
- Produces: registers `POST /api/checkout` on the app; response shape
  `{ orderId: string; clientSecret: string }`.

- [ ] **Step 1: Implement `src/routes/checkout.ts`**

```ts
import type { FastifyInstance } from "fastify";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { prisma } from "../db";
import { stripe } from "../stripeClient";
import { getBook } from "../pipeline/catalog";
import { computeTotalCents } from "../pricing";
import { buildConfigSnapshot, buildPrintPageKeys } from "../orderSnapshot";

const ErrorResponse = Type.Object({ message: Type.String() });

const CheckoutBody = Type.Object({
  sessionIds: Type.Array(Type.String({ format: "uuid" }), { minItems: 1 }),
  email: Type.String({ format: "email" }),
  shippingAddress: Type.Object({
    name: Type.String({ minLength: 1 }),
    line1: Type.String({ minLength: 1 }),
    line2: Type.Optional(Type.String()),
    city: Type.String({ minLength: 1 }),
    postalCode: Type.String({ minLength: 1 }),
    country: Type.String({ minLength: 2, maxLength: 2 }),
  }),
  gdprConsent: Type.Literal(true),
});
const CheckoutResponse = Type.Object({ orderId: Type.String(), clientSecret: Type.String() });

export async function registerCheckoutRoutes(app: FastifyInstance) {
  const api = app.withTypeProvider<TypeBoxTypeProvider>();

  api.post(
    "/api/checkout",
    {
      schema: {
        tags: ["checkout"],
        body: CheckoutBody,
        response: { 201: CheckoutResponse, 404: ErrorResponse, 409: ErrorResponse },
      },
    },
    async (request, reply) => {
      // gdprConsent isn't read here — Type.Literal(true) above already means
      // Fastify rejected the request before this handler ran if it was false/missing.
      const { sessionIds, email, shippingAddress } = request.body;

      const sessions = await prisma.session.findMany({
        where: { id: { in: sessionIds } },
        include: { characters: true },
      });
      if (sessions.length !== sessionIds.length) {
        return reply.code(404).send({ message: "One or more sessions were not found." });
      }
      for (const session of sessions) {
        if (session.characters.some((c) => !c.rawKey)) {
          return reply
            .code(409)
            .send({ message: `Session ${session.id} has a character with no uploaded photo.` });
        }
      }

      const storyIds = sessions.map((s) => s.storyId);
      const { totalCents, currency } = computeTotalCents(storyIds);

      const paymentIntent = await stripe.paymentIntents.create({
        amount: totalCents,
        currency,
        receipt_email: email,
        metadata: { sessionIds: sessionIds.join(",") },
      });

      const order = await prisma.order.create({
        data: {
          email,
          shippingName: shippingAddress.name,
          shippingLine1: shippingAddress.line1,
          shippingLine2: shippingAddress.line2 ?? null,
          shippingCity: shippingAddress.city,
          shippingPostalCode: shippingAddress.postalCode,
          shippingCountry: shippingAddress.country,
          totalCents,
          currency,
          // gdprConsent is Type.Literal(true) in the schema above — reaching
          // this line already proves consent, so we just timestamp it.
          gdprConsentAt: new Date(),
          stripePaymentIntentId: paymentIntent.id,
          items: {
            create: sessions.map((session) => {
              const book = getBook(session.storyId);
              return {
                sessionId: session.id,
                storyId: session.storyId,
                bookTitle: book.title,
                priceCents: book.priceCents,
                configSnapshot: buildConfigSnapshot(session.characters),
                printPageKeys: buildPrintPageKeys(session.id, book),
              };
            }),
          },
        },
      });

      reply.code(201);
      return { orderId: order.id, clientSecret: paymentIntent.client_secret! };
    },
  );
}
```

- [ ] **Step 2: Register the route in `app.ts`**

In `apps/api/src/app.ts`, add the import:
```ts
import { registerCheckoutRoutes } from "./routes/checkout";
```
and after `await registerSessionRoutes(app);`:
```ts
  await registerCheckoutRoutes(app);
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/api && npm run typecheck`
Expected: exits 0.

- [ ] **Step 4: Manual verification against a real (test-mode) Stripe key**

This route needs a live DB + a real `STRIPE_SECRET_KEY` (test mode) to
exercise — not something Vitest should fake per this plan's testing philosophy
(spec §7). With `npm run dev` running and test-mode Stripe keys set:

```bash
curl -X POST http://localhost:3001/api/checkout \
  -H "Content-Type: application/json" \
  -d '{
    "sessionIds": ["<a real session id with every character uploaded>"],
    "email": "test@example.com",
    "shippingAddress": {"name":"Test User","line1":"1 Rue Test","city":"Paris","postalCode":"75001","country":"FR"},
    "gdprConsent": true
  }'
```

Expected: `201` with `{ "orderId": "...", "clientSecret": "pi_..._secret_..." }`,
and a matching `Order`/`OrderItem` row visible via `npx prisma studio`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/checkout.ts apps/api/src/app.ts
git commit -m "feat: add POST /api/checkout"
```

---

### Task 12: Stripe + Gelato webhooks

**Files:**
- Create: `apps/api/src/routes/webhooks.ts`
- Modify: `apps/api/src/app.ts`

**Interfaces:**
- Consumes: `stripe` (Task 6), `prisma`, `canTransitionToPaid`, `mapGelatoStatus`
  (Task 3), `runFulfillment` (Task 10), `env.STRIPE_WEBHOOK_SECRET`,
  `env.GELATO_WEBHOOK_SECRET` (Task 5).
- Produces: registers `POST /api/webhooks/stripe` and `POST
  /api/webhooks/gelato` in their own encapsulated plugin context (raw-body
  parsing must NOT leak into the rest of the app's JSON routes).

- [ ] **Step 1: Implement `src/routes/webhooks.ts`**

```ts
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { prisma } from "../db";
import { env } from "../env";
import { stripe } from "../stripeClient";
import { canTransitionToPaid, mapGelatoStatus, ORDER_STATUS } from "../orderStatus";
import { runFulfillment } from "../fulfillment";

/**
 * Its own encapsulated plugin (registered via app.register, not called
 * directly like registerSessionRoutes) so the raw-body content-type parser
 * below applies ONLY to these two routes — Fastify plugin encapsulation means
 * every other route keeps normal JSON parsing.
 */
export async function registerWebhookRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => {
    done(null, body);
  });

  app.post("/api/webhooks/stripe", async (request, reply) => {
    const signature = request.headers["stripe-signature"];
    if (typeof signature !== "string") {
      return reply.code(400).send({ message: "Missing stripe-signature header." });
    }

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        request.body as Buffer,
        signature,
        env.STRIPE_WEBHOOK_SECRET ?? "",
      );
    } catch (error) {
      request.log.error({ error }, "Stripe webhook signature verification failed");
      return reply.code(400).send({ message: "Invalid signature." });
    }

    if (event.type === "payment_intent.succeeded") {
      const paymentIntent = event.data.object as { id: string };
      const order = await prisma.order.findUnique({ where: { stripePaymentIntentId: paymentIntent.id } });
      if (!order) {
        request.log.warn(`Stripe webhook for unknown PaymentIntent ${paymentIntent.id}`);
        return reply.code(200).send({ received: true });
      }
      if (canTransitionToPaid(order.status)) {
        await prisma.order.update({ where: { id: order.id }, data: { status: ORDER_STATUS.paid } });
        await prisma.orderStatusEvent.create({
          data: { orderId: order.id, status: ORDER_STATUS.paid, source: "stripe_webhook", raw: event as object },
        });
        // Fire-and-forget: Stripe expects a fast response, not a wait for
        // rendering + PDF assembly + Gelato dispatch (minutes, not seconds).
        void runFulfillment(order.id);
      }
    }

    return reply.code(200).send({ received: true });
  });

  app.post("/api/webhooks/gelato", async (request, reply) => {
    if (env.GELATO_WEBHOOK_SECRET) {
      const providedSecret = request.headers["x-gelato-webhook-secret"];
      if (providedSecret !== env.GELATO_WEBHOOK_SECRET) {
        return reply.code(401).send({ message: "Invalid webhook secret." });
      }
    }

    const payload = JSON.parse((request.body as Buffer).toString("utf-8")) as {
      orderReferenceId?: string;
      status?: string;
    };
    const { orderReferenceId, status } = payload;
    if (!orderReferenceId || !status) {
      return reply.code(400).send({ message: "Missing orderReferenceId or status." });
    }

    const mapped = mapGelatoStatus(status);
    await prisma.orderStatusEvent.create({
      data: {
        orderId: orderReferenceId,
        status: mapped ?? status,
        source: "gelato_webhook",
        raw: payload,
      },
    });
    if (mapped) {
      await prisma.order.update({ where: { id: orderReferenceId }, data: { status: mapped } });
    } else {
      request.log.warn(`Unrecognized Gelato status "${status}" for order ${orderReferenceId} — stored raw, order.status left unchanged.`);
    }

    return reply.code(200).send({ received: true });
  });
}
```

- [ ] **Step 2: Register the route in `app.ts`**

In `apps/api/src/app.ts`, add the import:
```ts
import { registerWebhookRoutes } from "./routes/webhooks";
```
and, alongside the other registrations — **as `app.register(...)`, not called
directly**, so Fastify creates the encapsulation boundary the raw-body parser
depends on:
```ts
  await app.register(registerWebhookRoutes);
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/api && npm run typecheck`
Expected: exits 0.

- [ ] **Step 4: Manual verification with the Stripe CLI**

```bash
stripe listen --forward-to localhost:3001/api/webhooks/stripe
# in a second terminal, once `stripe listen` prints a webhook signing secret:
stripe trigger payment_intent.succeeded
```

Expected: the API logs show the webhook received, and (if a matching
`stripePaymentIntentId` exists from a real Task 11 checkout run) the order's
status flips to `paid` and fulfillment starts. Confirm no CORS/JSON-parsing
regression on existing routes by re-running `test/e2e-single.mjs` once.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/webhooks.ts apps/api/src/app.ts
git commit -m "feat: add Stripe and Gelato webhook routes"
```

---

### Task 13: `GET /api/orders/:id`

**Files:**
- Create: `apps/api/src/routes/orders.ts`
- Modify: `apps/api/src/app.ts`

**Interfaces:**
- Consumes: `prisma`.
- Produces: registers `GET /api/orders/:id`; response includes `status`,
  `items` (bookTitle, priceCents), and `statusEvents` (status, source,
  createdAt) — powers the frontend's `/track/[orderId]` page.

- [ ] **Step 1: Implement `src/routes/orders.ts`**

```ts
import type { FastifyInstance } from "fastify";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { prisma } from "../db";

const ErrorResponse = Type.Object({ message: Type.String() });
const OrderParams = Type.Object({ id: Type.String({ format: "uuid" }) });

const OrderItemView = Type.Object({
  id: Type.String(),
  bookTitle: Type.String(),
  priceCents: Type.Number(),
});
const StatusEventView = Type.Object({
  status: Type.String(),
  source: Type.String(),
  createdAt: Type.String(),
});
const OrderView = Type.Object({
  id: Type.String(),
  status: Type.String(),
  email: Type.String(),
  totalCents: Type.Number(),
  currency: Type.String(),
  createdAt: Type.String(),
  items: Type.Array(OrderItemView),
  statusEvents: Type.Array(StatusEventView),
});

export async function registerOrderRoutes(app: FastifyInstance) {
  const api = app.withTypeProvider<TypeBoxTypeProvider>();

  api.get(
    "/api/orders/:id",
    {
      schema: {
        tags: ["orders"],
        params: OrderParams,
        response: { 200: OrderView, 404: ErrorResponse },
      },
    },
    async (request, reply) => {
      const order = await prisma.order.findUnique({
        where: { id: request.params.id },
        include: { items: true, statusEvents: { orderBy: { createdAt: "asc" } } },
      });
      if (!order) {
        return reply.code(404).send({ message: "Order not found" });
      }
      return {
        id: order.id,
        status: order.status,
        email: order.email,
        totalCents: order.totalCents,
        currency: order.currency,
        createdAt: order.createdAt.toISOString(),
        items: order.items.map((i) => ({ id: i.id, bookTitle: i.bookTitle, priceCents: i.priceCents })),
        statusEvents: order.statusEvents.map((e) => ({
          status: e.status,
          source: e.source,
          createdAt: e.createdAt.toISOString(),
        })),
      };
    },
  );
}
```

- [ ] **Step 2: Register the route in `app.ts`**

In `apps/api/src/app.ts`, add the import:
```ts
import { registerOrderRoutes } from "./routes/orders";
```
and after the checkout registration:
```ts
  await registerOrderRoutes(app);
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/api && npm run typecheck`
Expected: exits 0.

- [ ] **Step 4: Manual verification**

```bash
curl http://localhost:3001/api/orders/<a real order id from Task 11>
```
Expected: `200` with the order, its items, and its (possibly empty)
`statusEvents` array.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/orders.ts apps/api/src/app.ts
git commit -m "feat: add GET /api/orders/:id"
```

---

### Task 14: Full unit-test suite + typecheck sanity pass

**Files:** none (verification-only task)

- [ ] **Step 1: Run the full unit test suite**

Run: `cd apps/api && npm test`
Expected: PASS, 11 tests across `pricing.test.ts`, `orderStatus.test.ts`,
`orderSnapshot.test.ts`.

- [ ] **Step 2: Run the full typecheck**

Run: `cd apps/api && npm run typecheck`
Expected: exits 0.

- [ ] **Step 3: Confirm no regression on the existing session flow**

Run: `cd apps/api && node test/e2e-single.mjs <a real photo>` (needs
`npm run dev` running with real credentials — this is the existing script,
unchanged; it costs one real render, per [[api-cost-discipline]], so only run
it once here as a final regression check, not per-task).

Expected: same SSE `done` event this script has always produced — confirms
none of the new routes/plugins broke the existing session/render path.

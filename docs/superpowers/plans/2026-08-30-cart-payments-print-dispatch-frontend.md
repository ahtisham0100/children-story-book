# Cart, Payments & Print Dispatch — Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up `apps/web` (currently an empty placeholder — just a README)
as a real Next.js 14 App Router app with the four pages the spec calls for:
`/cart`, `/checkout`, `/confirmation`, `/track/[orderId]`.

**Architecture:** A from-scratch Next.js app calling the backend plan's API
(`POST /api/checkout`, `GET /api/orders/:id`, plus the existing `GET
/api/sessions/:id/pages`). The cart itself is a `localStorage` array of
session ids — no server cart table (see the spec). Checkout embeds Stripe's
Payment Element directly on the page. A small bridge change lets the existing
`homepage` app (where books are actually previewed today) hand a finished
session off into this cart.

**Tech Stack:** Next.js 14 (App Router), React 18, Tailwind CSS,
`@stripe/stripe-js` + `@stripe/react-stripe-js`.

**Spec:** [docs/superpowers/specs/2026-08-30-cart-payments-print-dispatch-design.md](../specs/2026-08-30-cart-payments-print-dispatch-design.md)

**Depends on:** the backend plan
(`docs/superpowers/plans/2026-08-30-cart-payments-print-dispatch-backend.md`)
must be implemented first — every page here calls its endpoints.

## Global Constraints

- No server-side cart table — cart state lives only in the browser
  (`localStorage`), read/written through `lib/cart.ts`.
- Book prices shown here are **display-only** (`lib/pricing.ts`) — the backend
  computes the real charge independently; a mismatch between the two is a
  cosmetic bug, never a billing bug.
- Visual language follows the reference site
  (`https://ahtisham0100.github.io/children-story-book-prototype/`): warm
  cream background, dark-brown serif headings, green pill CTA buttons, rounded
  cards — see the spec's §3 for the full palette/typography notes.
- No automated test runner for this app (matches how the existing `homepage`
  app is verified — manually, in a real browser, against a running API). Every
  task ends with a manual verification step instead.

---

### Task 1: Scaffold the Next.js + Tailwind app

**Files:**
- Create: `apps/web/package.json`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/next.config.mjs`
- Create: `apps/web/postcss.config.mjs`
- Create: `apps/web/app/layout.tsx`
- Create: `apps/web/app/globals.css`
- Create: `apps/web/app/page.tsx`
- Create: `apps/web/.env.local.example`
- Create: `apps/web/.gitignore`

**Interfaces:**
- Produces: a bootable Next.js app on port 3000, the Tailwind color tokens
  (`cream`, `ink`) used by every later page, and the `NEXT_PUBLIC_API_BASE_URL`
  / `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` env vars every later task reads.

- [ ] **Step 1: Initialize the package and install dependencies**

```bash
cd apps/web
npm init -y
npm install next@^14 react@^18 react-dom@^18 @stripe/stripe-js @stripe/react-stripe-js
npm install -D @types/node @types/react@^18 @types/react-dom@^18 tailwindcss postcss @tailwindcss/postcss
# Pin TypeScript to the 5.x line — npm's "latest" resolved a v7 whose package
# layout crashes Next.js 14.2's TypeScript-detection code at dev-server boot
# (confirmed live: "TypeError: Cannot read properties of undefined (reading
# 'endsWith')" inside verify-typescript-setup.js). Match apps/api's version.
npm install -D typescript@^5.7.2
```

Also note: npm resolves `tailwindcss` to v4 as of this writing, not v3 — v4
uses CSS-first theming (no `tailwind.config.ts`) and its own PostCSS plugin
package (`@tailwindcss/postcss`, installed above), which the steps below
already account for. If a future `npm install` resolves v3 instead, the
`@theme` block in Step 6 won't apply — check the installed major version
before assuming either config style.

- [ ] **Step 2: Write `package.json`**

Replace the generated `apps/web/package.json` with:

```json
{
  "name": "@childrens-book-platform/web",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "typecheck": "tsc --noEmit"
  }
}
```

(`npm install` already wrote the `dependencies`/`devDependencies` blocks from
Step 1 into this file — don't hand-type version numbers, keep what's there.)

- [ ] **Step 3: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2017",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 4: Write `next.config.mjs`**

```js
/** @type {import('next').NextConfig} */
const nextConfig = {};
export default nextConfig;
```

- [ ] **Step 5: Write `postcss.config.mjs`**

`apps/web/postcss.config.mjs` — Tailwind v4 ships its own PostCSS plugin
(Lightning CSS under the hood, which also handles vendor prefixing) — no
separate autoprefixer needed:
```js
export default {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};
```

- [ ] **Step 6: Write `app/globals.css`**

Tailwind v4 config lives in CSS via `@theme`, not `tailwind.config.ts` —
this registers `bg-cream`, `text-ink`, `font-serif`, etc. as real utility
classes:

```css
@import "tailwindcss";

@theme {
  --color-cream: #faf7f2;
  --color-ink: #3d2b1f;
  --color-accent: #e8c5a0;
  --font-serif: "Playfair Display", Georgia, serif;
}

body {
  background-color: var(--color-cream);
  color: var(--color-ink);
}
```

- [ ] **Step 7: Write `app/layout.tsx`**

```tsx
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Your Storybook — Cart & Checkout",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-cream text-ink">{children}</body>
    </html>
  );
}
```

- [ ] **Step 8: Write a placeholder `app/page.tsx`**

```tsx
import Link from "next/link";

export default function Home() {
  return (
    <main className="max-w-2xl mx-auto p-8">
      <h1 className="font-serif text-3xl mb-4">Your Storybook</h1>
      <p className="mb-6">
        Personalize a book on the homepage, then come back here to check out.
      </p>
      <Link href="/cart" className="rounded-full bg-green-700 text-white px-6 py-3 font-medium">
        View cart
      </Link>
    </main>
  );
}
```

- [ ] **Step 9: Write `.env.local.example` and `.gitignore`**

`apps/web/.env.local.example`:
```
NEXT_PUBLIC_API_BASE_URL=http://localhost:3001
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=
```

`apps/web/.gitignore`:
```
node_modules
.next
.env.local
```

- [ ] **Step 10: Verify it boots**

```bash
cd apps/web && npm run dev
```
Expected: server starts on `http://localhost:3000`; opening it in a browser
shows the cream-background "Your Storybook" placeholder page with a working
"View cart" link (which 404s for now — that's Task 3).

- [ ] **Step 11: Commit**

```bash
git add apps/web
git commit -m "feat(web): scaffold Next.js 14 + Tailwind app"
```

---

### Task 2: API client, cart storage, and display pricing

**Files:**
- Create: `apps/web/lib/api.ts`
- Create: `apps/web/lib/cart.ts`
- Create: `apps/web/lib/pricing.ts`

**Interfaces:**
- Produces: `apiGet<T>(path): Promise<T>`, `apiPost<T>(path, body): Promise<T>`,
  `API_BASE_URL` from `lib/api.ts`; `getCartSessionIds(): string[]`,
  `addSessionToCart(id)`, `removeSessionFromCart(id)`, `clearCart()` from
  `lib/cart.ts`; `BOOK_PRICES_CENTS`, `formatMoney(cents, currency?)` from
  `lib/pricing.ts` — all consumed by Tasks 3-6.

- [ ] **Step 1: Implement `lib/api.ts`**

```ts
export const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`);
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error((payload as { message?: string }).message ?? `POST ${path} failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}
```

- [ ] **Step 2: Implement `lib/cart.ts`**

```ts
const CART_KEY = "storybook_cart_session_ids";

export function getCartSessionIds(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(CART_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function saveCartSessionIds(ids: string[]): void {
  window.localStorage.setItem(CART_KEY, JSON.stringify(ids));
}

export function addSessionToCart(sessionId: string): void {
  const ids = getCartSessionIds();
  if (!ids.includes(sessionId)) saveCartSessionIds([...ids, sessionId]);
}

export function removeSessionFromCart(sessionId: string): void {
  saveCartSessionIds(getCartSessionIds().filter((id) => id !== sessionId));
}

export function clearCart(): void {
  window.localStorage.removeItem(CART_KEY);
}
```

- [ ] **Step 3: Implement `lib/pricing.ts`**

```ts
// DISPLAY ONLY. apps/api/src/pipeline/catalog.ts is the sole source of truth
// for the actual charge — POST /api/checkout computes the real total
// server-side regardless of what's shown here. Keep these numbers in sync
// with that file when either changes, but a mismatch here is a cosmetic bug,
// never a billing bug.
export const BOOK_PRICES_CENTS: Record<string, number> = {
  "demo-book": 3490,
  "demo-book-duo": 3490,
};

export function formatMoney(cents: number, currency = "EUR"): string {
  return new Intl.NumberFormat("en", { style: "currency", currency }).format(cents / 100);
}
```

- [ ] **Step 4: Typecheck**

Run: `cd apps/web && npm run typecheck`
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib
git commit -m "feat(web): add API client, cart storage, and display pricing"
```

---

### Task 3: `/cart` page

**Files:**
- Create: `apps/web/app/cart/page.tsx`

**Interfaces:**
- Consumes: `getCartSessionIds`, `addSessionToCart`, `removeSessionFromCart`
  (Task 2), `apiGet` (Task 2), `BOOK_PRICES_CENTS`, `formatMoney` (Task 2). Calls
  the existing `GET /api/sessions/:id/pages` (unmodified, already in `apps/api`).
- Produces: the `/cart` route; reads `?add=<sessionId>` to merge in a session
  from an external link (the homepage bridge, Task 7).

- [ ] **Step 1: Implement `app/cart/page.tsx`**

```tsx
"use client";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { addSessionToCart, getCartSessionIds, removeSessionFromCart } from "@/lib/cart";
import { apiGet } from "@/lib/api";
import { BOOK_PRICES_CENTS, formatMoney } from "@/lib/pricing";

interface SessionPagesResponse {
  sessionId: string;
  storyId: string;
  title: string;
  pages: { id: string; url: string | null }[];
}

function CartPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [items, setItems] = useState<SessionPagesResponse[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const addId = searchParams.get("add");
    if (addId) {
      addSessionToCart(addId);
      router.replace("/cart");
    }
  }, [searchParams, router]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      const ids = getCartSessionIds();
      const results = await Promise.all(
        ids.map((id) => apiGet<SessionPagesResponse>(`/api/sessions/${id}/pages`).catch(() => null)),
      );
      if (!cancelled) {
        setItems(results.filter((r): r is SessionPagesResponse => r !== null));
        setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [searchParams]);

  const handleRemove = (sessionId: string) => {
    removeSessionFromCart(sessionId);
    setItems((prev) => prev.filter((i) => i.sessionId !== sessionId));
  };

  const totalCents = items.reduce((sum, item) => sum + (BOOK_PRICES_CENTS[item.storyId] ?? 0), 0);

  if (loading) return <main className="max-w-2xl mx-auto p-8">Loading your cart…</main>;

  return (
    <main className="max-w-2xl mx-auto p-8">
      <h1 className="font-serif text-3xl mb-6">Your cart</h1>
      {items.length === 0 ? (
        <>
          <p className="mb-6">Your cart is empty for now.</p>
          <Link href="/" className="rounded-full bg-green-700 text-white px-6 py-3 font-medium">
            Browse the stories
          </Link>
        </>
      ) : (
        <>
          <ul className="space-y-4">
            {items.map((item) => (
              <li key={item.sessionId} className="flex items-center justify-between border rounded-xl p-4">
                <div>
                  <p className="font-medium">{item.title}</p>
                  <p className="text-sm text-gray-600">{formatMoney(BOOK_PRICES_CENTS[item.storyId] ?? 0)}</p>
                </div>
                <button onClick={() => handleRemove(item.sessionId)} className="text-sm underline">
                  Remove
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-6 flex items-center justify-between">
            <p className="font-medium">Total: {formatMoney(totalCents)}</p>
            <Link href="/checkout" className="rounded-full bg-green-700 text-white px-6 py-3 font-medium">
              Proceed to checkout →
            </Link>
          </div>
        </>
      )}
    </main>
  );
}

export default function CartPage() {
  return (
    <Suspense fallback={<main className="max-w-2xl mx-auto p-8">Loading…</main>}>
      <CartPageInner />
    </Suspense>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/web && npm run typecheck`
Expected: exits 0.

- [ ] **Step 3: Manual verification**

With `apps/api`'s `npm run dev` running and at least one real, fully-uploaded
session id on hand (from a prior `homepage` run or `test/e2e-single.mjs`):

```bash
cd apps/web && npm run dev
```
Open `http://localhost:3000/cart?add=<that session id>` in a browser. Expected:
the `?add=` param disappears from the URL, the book's title and display price
appear as a line item, "Remove" removes it and shows the empty state, and
re-adding via the same URL brings it back.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/cart
git commit -m "feat(web): add /cart page"
```

---

### Task 4: `/checkout` page

**Files:**
- Create: `apps/web/app/checkout/page.tsx`

**Interfaces:**
- Consumes: `getCartSessionIds` (Task 2), `apiPost` (Task 2),
  `@stripe/stripe-js`'s `loadStripe`, `@stripe/react-stripe-js`'s `Elements`,
  `PaymentElement`, `useStripe`, `useElements`. Calls the backend plan's `POST
  /api/checkout`.
- Produces: the `/checkout` route; on successful payment, navigates to
  `/confirmation?order=<id>`.

- [ ] **Step 1: Implement `app/checkout/page.tsx`**

```tsx
"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { loadStripe } from "@stripe/stripe-js";
import { Elements, PaymentElement, useStripe, useElements } from "@stripe/react-stripe-js";
import { getCartSessionIds } from "@/lib/cart";
import { apiPost } from "@/lib/api";

const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? "");

interface CheckoutResponse {
  orderId: string;
  clientSecret: string;
}

function PaymentStep({ orderId }: { orderId: string }) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handlePay = async () => {
    if (!stripe || !elements) return;
    setSubmitting(true);
    setError(null);
    const { error: confirmError } = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: `${window.location.origin}/confirmation?order=${orderId}` },
    });
    if (confirmError) {
      setError(confirmError.message ?? "Payment failed.");
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      <PaymentElement />
      {error && <p className="text-red-600 text-sm">{error}</p>}
      <button
        onClick={handlePay}
        disabled={submitting}
        className="w-full rounded-full bg-green-700 text-white py-3 font-medium disabled:opacity-50"
      >
        {submitting ? "Processing…" : "Pay now"}
      </button>
    </div>
  );
}

export default function CheckoutPage() {
  const router = useRouter();
  const [checkout, setCheckout] = useState<CheckoutResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({
    email: "",
    name: "",
    line1: "",
    line2: "",
    city: "",
    postalCode: "",
    country: "FR",
  });
  const [gdprConsent, setGdprConsent] = useState(false);

  const handleContinue = async () => {
    const sessionIds = getCartSessionIds();
    if (sessionIds.length === 0) {
      router.push("/cart");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await apiPost<CheckoutResponse>("/api/checkout", {
        sessionIds,
        email: form.email,
        shippingAddress: {
          name: form.name,
          line1: form.line1,
          line2: form.line2 || undefined,
          city: form.city,
          postalCode: form.postalCode,
          country: form.country,
        },
        gdprConsent: true,
      });
      setCheckout(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Checkout failed.");
    } finally {
      setSubmitting(false);
    }
  };

  if (checkout) {
    return (
      <main className="max-w-lg mx-auto p-8">
        <h1 className="font-serif text-3xl mb-6">Payment</h1>
        <Elements stripe={stripePromise} options={{ clientSecret: checkout.clientSecret }}>
          <PaymentStep orderId={checkout.orderId} />
        </Elements>
      </main>
    );
  }

  const canContinue =
    gdprConsent && form.email && form.name && form.line1 && form.city && form.postalCode && form.country.length === 2;

  return (
    <main className="max-w-lg mx-auto p-8">
      <h1 className="font-serif text-3xl mb-6">Delivery details</h1>
      <div className="space-y-3">
        <input
          className="w-full border rounded p-2"
          placeholder="Email"
          type="email"
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
        />
        <input
          className="w-full border rounded p-2"
          placeholder="Full name"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
        <input
          className="w-full border rounded p-2"
          placeholder="Address line 1"
          value={form.line1}
          onChange={(e) => setForm({ ...form, line1: e.target.value })}
        />
        <input
          className="w-full border rounded p-2"
          placeholder="Address line 2 (optional)"
          value={form.line2}
          onChange={(e) => setForm({ ...form, line2: e.target.value })}
        />
        <input
          className="w-full border rounded p-2"
          placeholder="City"
          value={form.city}
          onChange={(e) => setForm({ ...form, city: e.target.value })}
        />
        <input
          className="w-full border rounded p-2"
          placeholder="Postal code"
          value={form.postalCode}
          onChange={(e) => setForm({ ...form, postalCode: e.target.value })}
        />
        <input
          className="w-full border rounded p-2"
          placeholder="Country code (e.g. FR)"
          maxLength={2}
          value={form.country}
          onChange={(e) => setForm({ ...form, country: e.target.value.toUpperCase() })}
        />
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" checked={gdprConsent} onChange={(e) => setGdprConsent(e.target.checked)} />
          <span>
            I consent to my photos being used to personalize this book. Raw photos are
            automatically deleted within 24 hours of delivery.
          </span>
        </label>
        {error && <p className="text-red-600 text-sm">{error}</p>}
        <button
          onClick={handleContinue}
          disabled={submitting || !canContinue}
          className="w-full rounded-full bg-green-700 text-white py-3 font-medium disabled:opacity-50"
        >
          {submitting ? "Please wait…" : "Continue to payment"}
        </button>
      </div>
    </main>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/web && npm run typecheck`
Expected: exits 0.

- [ ] **Step 3: Manual verification**

Requires the backend plan's Task 11-12 done, `apps/api` running with real
test-mode `STRIPE_SECRET_KEY`, and `apps/web`'s `.env.local` with a matching
test-mode `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`. With at least one session in
the cart (Task 3), go to `/checkout`, fill the form, check the GDPR box, click
"Continue to payment" — expected: the Payment Element appears. Use Stripe's
test card `4242 4242 4242 4242`, any future expiry, any CVC, and submit.
Expected: redirect to `/confirmation?order=<id>` and (per the backend plan's
Task 12 manual check) the order's status flips to `paid` once Stripe's webhook
reaches your locally-running `stripe listen` forwarder.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/checkout
git commit -m "feat(web): add /checkout page with embedded Stripe Payment Element"
```

---

### Task 5: `/confirmation` page

**Files:**
- Create: `apps/web/app/confirmation/page.tsx`

**Interfaces:**
- Consumes: `apiGet` (Task 2), `clearCart` (Task 2). Calls the backend plan's
  `GET /api/orders/:id`.
- Produces: the `/confirmation` route, reached via `?order=<id>`.

- [ ] **Step 1: Implement `app/confirmation/page.tsx`**

```tsx
"use client";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { apiGet } from "@/lib/api";
import { formatMoney } from "@/lib/pricing";
import { clearCart } from "@/lib/cart";

interface OrderView {
  id: string;
  status: string;
  totalCents: number;
  currency: string;
  items: { id: string; bookTitle: string; priceCents: number }[];
}

function ConfirmationInner() {
  const searchParams = useSearchParams();
  const orderId = searchParams.get("order");
  const [order, setOrder] = useState<OrderView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!orderId) return;
    clearCart();
    apiGet<OrderView>(`/api/orders/${orderId}`)
      .then(setOrder)
      .catch(() => setError("We couldn't find that order."));
  }, [orderId]);

  if (!orderId) return <main className="max-w-2xl mx-auto p-8">No order specified.</main>;
  if (error) return <main className="max-w-2xl mx-auto p-8">{error}</main>;
  if (!order) return <main className="max-w-2xl mx-auto p-8">Loading your order…</main>;

  return (
    <main className="max-w-2xl mx-auto p-8">
      <h1 className="font-serif text-3xl mb-2">Order confirmed!</h1>
      <p className="text-gray-600 mb-6">Order ID: {order.id}</p>
      <ul className="space-y-2 mb-6">
        {order.items.map((item) => (
          <li key={item.id} className="flex justify-between">
            <span>{item.bookTitle}</span>
            <span>{formatMoney(item.priceCents, order.currency)}</span>
          </li>
        ))}
      </ul>
      <p className="font-medium mb-8">Total: {formatMoney(order.totalCents, order.currency)}</p>
      <div className="rounded-xl border p-4 mb-8">
        <p className="font-medium mb-1">Your data, protected by design</p>
        <p className="text-sm text-gray-600">
          Your uploaded photos are automatically deleted within 24 hours of your order being
          marked delivered.
        </p>
      </div>
      <Link href={`/track/${order.id}`} className="rounded-full bg-green-700 text-white px-6 py-3 font-medium">
        Track your order →
      </Link>
    </main>
  );
}

export default function ConfirmationPage() {
  return (
    <Suspense fallback={<main className="max-w-2xl mx-auto p-8">Loading…</main>}>
      <ConfirmationInner />
    </Suspense>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/web && npm run typecheck`
Expected: exits 0.

- [ ] **Step 3: Manual verification**

Navigate to `/confirmation?order=<a real order id>` (from Task 4's flow, or
directly via `curl -X POST .../api/checkout` from the backend plan). Expected:
receipt with book titles and total, the GDPR notice box, and a working
"Track your order" link. Navigate to `/confirmation` with no `?order=` —
expected: "No order specified." instead of a crash.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/confirmation
git commit -m "feat(web): add /confirmation page"
```

---

### Task 6: `/track/[orderId]` page

**Files:**
- Create: `apps/web/app/track/[orderId]/page.tsx`

**Interfaces:**
- Consumes: `API_BASE_URL` (Task 2), `formatMoney` (Task 2). Calls the backend
  plan's `GET /api/orders/:id` server-side (this is a React Server Component,
  not a client component — no browser JS needed to render it).
- Produces: the `/track/[orderId]` route, no login required.

- [ ] **Step 1: Implement `app/track/[orderId]/page.tsx`**

```tsx
import { API_BASE_URL } from "@/lib/api";
import { formatMoney } from "@/lib/pricing";

interface OrderView {
  id: string;
  status: string;
  totalCents: number;
  currency: string;
  items: { id: string; bookTitle: string; priceCents: number }[];
  statusEvents: { status: string; source: string; createdAt: string }[];
}

async function getOrder(orderId: string): Promise<OrderView | null> {
  const res = await fetch(`${API_BASE_URL}/api/orders/${orderId}`, { cache: "no-store" });
  if (!res.ok) return null;
  return res.json();
}

export default async function TrackOrderPage({ params }: { params: { orderId: string } }) {
  const order = await getOrder(params.orderId);
  if (!order) {
    return <main className="max-w-2xl mx-auto p-8">Order not found.</main>;
  }

  return (
    <main className="max-w-2xl mx-auto p-8">
      <h1 className="font-serif text-3xl mb-2">Track your order</h1>
      <p className="text-gray-600 mb-6">
        Order ID: {order.id} · Status: {order.status.replace(/_/g, " ")}
      </p>
      <ul className="space-y-2 mb-8">
        {order.items.map((item) => (
          <li key={item.id} className="flex justify-between">
            <span>{item.bookTitle}</span>
            <span>{formatMoney(item.priceCents, order.currency)}</span>
          </li>
        ))}
      </ul>
      <h2 className="font-medium mb-3">Status history</h2>
      <ol className="space-y-3 border-l-2 border-green-700 pl-4">
        {order.statusEvents.length === 0 && (
          <li className="text-gray-600">Awaiting payment confirmation.</li>
        )}
        {order.statusEvents.map((event, i) => (
          <li key={i}>
            <p className="font-medium">{event.status.replace(/_/g, " ")}</p>
            <p className="text-sm text-gray-600">{new Date(event.createdAt).toLocaleString()}</p>
          </li>
        ))}
      </ol>
    </main>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/web && npm run typecheck`
Expected: exits 0.

- [ ] **Step 3: Manual verification**

Navigate to `/track/<a real order id>`. Expected: order items, current status,
and a chronological timeline of `statusEvents` (empty-state message if none
yet). Navigate to `/track/not-a-real-id` — expected: "Order not found."
instead of a crash.

- [ ] **Step 4: Commit**

```bash
git add "apps/web/app/track"
git commit -m "feat(web): add /track/[orderId] page"
```

---

### Task 7: Bridge — "Add to cart" link from the existing homepage

**Files:**
- Modify: `apps/api/homepage/index.html`

**Interfaces:**
- Modifies the existing `pollPages` function's completion branch (around the
  `if (keys.every((k) => st.rendered.has(k)))` check) to also render a link
  into `apps/web`'s `/cart`.

- [ ] **Step 1: Add the cart link at the render-complete point**

In `apps/api/homepage/index.html`, inside the `pollPages` function, find:

```js
    if (keys.every((k) => st.rendered.has(k))) {
      finish("Finished in <b>" + fmt(Math.round((Date.now() - started) / 1000)) + "</b>");
    }
```

Replace it with:

```js
    if (keys.every((k) => st.rendered.has(k))) {
      // Bridge into the standalone cart/checkout app (apps/web). Hardcoded
      // localhost default matches how this file already hardcodes its own
      // local-dev assumptions elsewhere — point this at the real deployed
      // web app's origin once one exists.
      const webAppUrl = window.WEB_APP_URL || "http://localhost:3000";
      const cartUrl = webAppUrl + "/cart?add=" + encodeURIComponent(sessionId);
      finish(
        "Finished in <b>" + fmt(Math.round((Date.now() - started) / 1000)) + "</b> · " +
          '<a class="dl" href="' + cartUrl + '">Add this book to cart →</a>',
      );
    }
```

- [ ] **Step 2: Manual verification**

```bash
cd apps/api && npm run homepage
```
In a browser, run a real personalization (this costs one real render — reuse
whatever test photo/session you already have from other verification steps in
this plan rather than triggering a fresh one), let it finish, and confirm the
"Add this book to cart →" link appears next to the elapsed-time message and
that clicking it opens `apps/web`'s `/cart` page (started via `npm run dev` in
`apps/web`) with the book already added.

- [ ] **Step 3: Commit**

```bash
git add apps/api/homepage/index.html
git commit -m "feat(homepage): add bridge link into the cart app"
```

---

### Task 8: Full manual walkthrough (final verification)

**Files:** none (verification-only task)

- [ ] **Step 1: Run the whole flow start to finish**

With `apps/api` (`npm run dev`), `apps/web` (`npm run dev`), and `stripe
listen --forward-to localhost:3001/api/webhooks/stripe` all running:

1. Personalize a book via `apps/api/homepage`, click "Add this book to cart".
2. On `/cart`, confirm the book and price are shown; click "Proceed to checkout".
3. On `/checkout`, fill the address form, check GDPR consent, pay with Stripe's
   test card `4242 4242 4242 4242`.
4. Confirm landing on `/confirmation` with the correct receipt and GDPR notice.
5. Click "Track your order"; confirm `/track/[orderId]` loads.
6. Watch the `apps/api` server logs: full-book render kicks off, PDF assembly
   runs, a Gelato dispatch attempt is made (expected to fail without real
   Gelato credentials — confirm the order status lands on `failed` with an
   `OrderStatusEvent` explaining why, rather than hanging silently), and no
   unhandled exceptions are logged.

Expected: every step above completes exactly as described; any deviation is a
bug in one of Tasks 1-7 (this app) or the backend plan, not a new requirement.

- [ ] **Step 2: Report the one known gap**

Gelato dispatch will genuinely fail end-to-end until the user completes the
account-setup checklist (delivered alongside this plan, outside its scope per
spec §9) and a real `GELATO_PRODUCT_UID`/`GELATO_API_KEY` are configured. This
is expected, not a regression — confirm the failure is visible and explained
in the order's status history (Task 6 renders exactly this), not swallowed.

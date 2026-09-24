# apps/web — cart, checkout, and order tracking

Next.js 14 (App Router) + Tailwind. No longer the empty placeholder described
in older docs (`PROJECT_PLAN.md` §8's "deferred, API-only" note is now
historical) — this app implements the Phase 2 Part 1 spec's four frontend
pages:

- `/cart` — reads a `localStorage` list of session ids, shows each book's
  title/price, lets you remove items or continue to checkout.
- `/checkout` — delivery address form, GDPR consent checkbox, and an embedded
  Stripe Payment Element, all on one page.
- `/confirmation` — receipt + GDPR photo-deletion timeline for a completed order.
- `/track/[orderId]` — public order-status timeline, no login required.

Added later (Milestone 4):

- `/account` — tabs: **Orders** and **My Data** (photo status, deletion dates, "Delete my data now").
- `/admin` — internal dashboard for customers with `role = "admin"` (`npm run make-admin -- <email>` in
  apps/api): **Queues** (counts, jobs, failed-job inspector, retry, Gelato reconcile), **Orders** (filters,
  timeline, status changes, Gelato sync), **Storage** (R2 usage, per-session files), **Deletions**
  (scheduled, audit log, manual override, sweep now). `lib/admin.ts` sends the `X-Admin-Request` header the
  API requires. The page gate is cosmetic; the API checks the role on every call. Demo data:
  `npx tsx test/seed-admin-demo.mts` in apps/api.

Every page is a client component that fetches in the browser: a server-side fetch crashes the Next 14 dev
worker in this repo (see `app/track/[orderId]/page.tsx`). Destructive or state-changing actions go through
`components/ConfirmModal.tsx`.

**Do not confuse this with the homepage that also exists.** A separate,
self-contained personalization UI lives at `apps/api/homepage`
(`npm run homepage`, port 5174) — that's still where a book is actually
previewed. This app picks up from there: `apps/api/homepage/index.html` links
a finished preview into `/cart?add=<sessionId>` once it's done rendering.

**Design/spec:**
[docs/superpowers/specs/2026-08-30-cart-payments-print-dispatch-design.md](../../docs/superpowers/specs/2026-08-30-cart-payments-print-dispatch-design.md)
**Implementation plan:**
[docs/superpowers/plans/2026-08-30-cart-payments-print-dispatch-frontend.md](../../docs/superpowers/plans/2026-08-30-cart-payments-print-dispatch-frontend.md)

## Running it

```bash
npm install
cp .env.local.example .env.local   # fill in NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
npm run dev                        # http://localhost:3000
```

Needs `apps/api` running (`npm run dev`, port 3001) for every page except the
placeholder home page — none of this works standalone.

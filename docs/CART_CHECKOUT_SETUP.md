# Cart, Payments & Print Dispatch — setup checklist

Everything in this doc is a manual account/dashboard step, not code. Follow
it in order; each section says exactly what env var(s) it produces.

Spec: [docs/superpowers/specs/2026-08-30-cart-payments-print-dispatch-design.md](superpowers/specs/2026-08-30-cart-payments-print-dispatch-design.md)

## Status — 2026-08-30, live-verified against real test-mode infra

- **Stripe: fully verified end to end.** Real PaymentIntent created by
  `POST /api/checkout`, real Payment Element mounted, payment confirmed via
  Stripe's test card token, webhook delivered and signature-verified, order
  correctly transitioned `awaiting_payment → paid` with a full audit trail.
- **Resend: verified.** `sendOrderConfirmationEmail` sent a real email via
  the account's sandbox sender (`onboarding@resend.dev`) — works today, no
  domain verification needed yet, but only delivers to the account's own
  email until one is added (see §3).
- **Gelato: request shape verified, no order actually placed.**
  `assembleItemPdf` → `submitOrderToGelato` reached Gelato's live order API
  and got a clean `400 BAD_REQUEST — "complete the company information in
  the portal"` — i.e. auth and request shape are correct, but the account
  needs billing/company info added before it will accept any order (see §2
  for the real product UID this was tested against, and the page-count issue
  it surfaced).
- **Found and fixed separately:** the Upstash Redis instance referenced in
  `.env` had stopped resolving in DNS entirely (likely reclaimed for
  inactivity) — this blocked the *entire* existing render pipeline, not
  anything new. A fresh Upstash instance is now wired in and confirmed
  working. **Update (2026-09-23):** fulfilment no longer runs as an
  in-process promise. The Stripe webhook only enqueues a job on the
  `fulfillment` BullMQ queue (`jobId` = order id), consumed by
  `src/fulfillmentWorker.ts`. Retries: 5 attempts with exponential backoff.
  Failed jobs are kept for inspection. Every step is idempotent: the render
  is skipped if the pages exist, the PDF is skipped if stored, emails are
  stamped with `*EmailSentAt`, and Gelato is **never** submitted twice.
  If Redis is unreachable when the webhook arrives, the webhook answers
  5xx and Stripe redelivers it, so a paid order is no longer silently
  dropped by a crash or Redis blip.

## 1. Stripe

1. Create a Stripe account at https://dashboard.stripe.com/register if you
   don't have one.
2. Stay in **Test mode** (toggle top-right of the dashboard) for everything
   below until you're ready to actually charge real cards.
3. Go to **Developers → API keys**. Copy:
   - **Secret key** (`sk_test_...`) → `apps/api/.env`'s `STRIPE_SECRET_KEY`
   - **Publishable key** (`pk_test_...`) → `apps/web/.env.local`'s
     `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`
4. Install the Stripe CLI (https://docs.stripe.com/stripe-cli) for local
   webhook testing:
   ```bash
   stripe login
   stripe listen --forward-to localhost:3001/api/webhooks/stripe
   ```
   The CLI prints a webhook signing secret (`whsec_...`) — put that in
   `apps/api/.env`'s `STRIPE_WEBHOOK_SECRET`. This secret is **local-CLI-only**
   and different from the one you'll get in step 6 for a real deployment.
5. Test the flow with Stripe's test card `4242 4242 4242 4242`, any future
   expiry date, any 3-digit CVC, any postal code. Full list of test cards
   (including ones that simulate declines) at
   https://docs.stripe.com/testing.
6. **Before going live** (real deployment, real charges):
   - Switch to **Live mode**, get the live `sk_live_...`/`pk_live_...` keys.
   - In **Developers → Webhooks**, add an endpoint pointing at your deployed
     API's `/api/webhooks/stripe` URL, subscribed to at least
     `payment_intent.succeeded`. This gives you a **new**, production
     `whsec_...` — use that in your deployed environment, not the CLI one.
   - Stripe requires a real business profile (legal name, address, bank
     account for payouts) before Live mode accepts real charges — fill that
     in under **Settings → Business settings**.

## 2. Gelato (print-on-demand dispatch)

**Update:** the request shape in `apps/api/src/print/gelato.ts` (URL, auth
header, field names) is now confirmed correct — verified live against
Gelato's real order-create API, which returned a clean business-rule
rejection rather than an auth/schema error (see status section above). Two
real things surfaced that still need your decision, not code fixes:

1. **A real, working product UID is already wired into `apps/api/.env`:**
   ```
   GELATO_PRODUCT_UID=photobooks-hardcover_pf_200x200-mm-8x8-inch_pt_170-gsm-65lb-coated-silk_cl_4-4_ccl_4-4_bt_glued-left_ct_matt-lamination_prt_1-0_cpt_130-gsm-65-lb-cover-coated-silk_ver
   ```
   An 8×8in hardcover photobook, confirmed via Gelato's Product Catalog API
   (`product.gelatoapis.com/v3/products/{uid}`) to have **zero unsupported
   countries**. **Watch out:** a near-identical UID exists with the trim-size
   segment reordered (`8x8-inch-200x200-mm` instead of
   `200x200-mm-8x8-inch`) that looks identical but excludes 238 countries
   including France, the US, and the UK — always check `notSupportedCountries`
   on the *product detail* endpoint (the catalog *search* endpoint doesn't
   populate this field reliably) before trusting a UID.
2. **This product needs a minimum of 28 pages** (steps of 2, up to 200).
   `apps/api/src/pipeline/catalog.ts`'s current book configs (`demo-book`: 3
   pages, `demo-book-duo`: 2 pages) are demo/prototype content — real
   sellable books need either 28+ pages of actual illustrated content, or a
   different Gelato product with a lower minimum (worth checking other
   catalogs — `soft-cover-photobooks` has the same 28-page floor, but
   smaller formats like `cards` or `folded-cards` might not). This is a
   content/business decision, not something to guess at in code.
3. `PRINT_TRIM_WIDTH_IN`/`PRINT_TRIM_HEIGHT_IN` in `.env` are already set to
   `8`/`8` to match this product's real 203.2mm (~8in) page size.
4. **Before any order will actually go through:** Gelato's dashboard needs
   company/billing information completed (Settings → Company/Billing in
   their dashboard) — that's the exact thing the test rejection asked for.
5. **The Gelato webhook fails closed.** `/api/webhooks/gelato` rejects every
   request (401) unless `GELATO_WEBHOOK_SECRET` is set and the request's
   `x-gelato-webhook-secret` header matches it (constant-time compare). For
   local testing only, `GELATO_WEBHOOK_ALLOW_UNSIGNED=true` accepts unsigned
   requests while no secret is set; the API logs a warning at startup when
   it's on. Other behaviour: malformed JSON returns 400, and an unknown
   `orderReferenceId` is logged and acknowledged with 200 so Gelato doesn't
   retry it forever.
   Put the secret Gelato's dashboard gives you for order-status
   callbacks in `apps/api/.env`'s `GELATO_WEBHOOK_SECRET` and confirm
   `apps/api/src/orderStatus.ts`'s `mapGelatoStatus` covers every status
   string their webhook actually sends (extend the map if not — it currently
   covers `created`, `in_production`, `printed`, `shipped`, `delivered`,
   `cancelled`, `failed` as a best guess, still unverified against a real
   webhook delivery).
6. Configure the webhook callback URL in Gelato's dashboard to point at your
   deployed API's `/api/webhooks/gelato`.

## 3. Resend (order confirmation email)

1. Create a Resend account at https://resend.com/signup.
2. **Add and verify a sending domain**: Dashboard → Domains → Add Domain,
   then add the DNS records (SPF/DKIM) it gives you at your domain registrar.
   This can take a few minutes to a few hours to verify. Without a verified
   domain, Resend only lets you send to your own account's email address —
   fine for testing, not for real customers.
3. Once verified, go to **API Keys** → create one → put it in `apps/api/.env`'s
   `RESEND_API_KEY`.
4. Set `apps/api/.env`'s `RESEND_FROM_ADDRESS` to an address at your verified
   domain (e.g. `orders@yourdomain.com`). **Until you add one**,
   `RESEND_FROM_ADDRESS=onboarding@resend.dev` (Resend's own sandbox sender)
   works with zero setup — confirmed live, a real email delivered
   successfully — but only to the account's own signup email, not customers.
5. Send yourself a real test order (see the walkthrough below) and confirm
   the email arrives and isn't in spam — if it lands in spam, check your
   domain's DKIM/SPF/DMARC setup in Resend's domain verification page.

## 4. Wiring it together — env files

`apps/api/.env` needs (see `apps/api/.env.example` for the full list, this is
just the new section):
```
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
GELATO_API_KEY=...
GELATO_PRODUCT_UID=...
GELATO_WEBHOOK_SECRET=...        # required: the Gelato webhook rejects everything without it
GELATO_WEBHOOK_ALLOW_UNSIGNED=false   # dev only; true accepts unsigned webhooks when no secret is set
RESEND_API_KEY=re_...
RESEND_FROM_ADDRESS=orders@yourdomain.com   # or onboarding@resend.dev for now
PRINT_TRIM_WIDTH_IN=8            # matches the wired-in Gelato product
PRINT_TRIM_HEIGHT_IN=8
```

`apps/web/.env.local` (copy from `.env.local.example`) needs:
```
NEXT_PUBLIC_API_BASE_URL=http://localhost:3001    # or your deployed API URL
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_...
```

## 5. Full local walkthrough, once the above is done

```bash
# terminal 1
cd apps/api && npm run dev

# terminal 2
cd apps/api && stripe listen --forward-to localhost:3001/api/webhooks/stripe

# terminal 3
cd apps/web && npm run dev

# terminal 4 — optional, only needed if you want to start from a real
# personalized preview rather than an existing session id
cd apps/api && npm run homepage
```

1. Personalize a book via the homepage (`http://127.0.0.1:5174`) — this
   costs one real Replicate render, budget accordingly.
2. Click "Add this book to cart" once it finishes.
3. On `/cart` (`http://localhost:3000/cart`), confirm the book and price,
   click "Proceed to checkout".
4. Fill the address form, check GDPR consent, pay with the Stripe test card.
5. Confirm you land on `/confirmation` with the right receipt.
6. Watch the `apps/api` terminal: the webhook enqueues a `fulfillment` job,
   which renders the full book (skipped if already rendered), assembles a PDF,
   then calls Gelato. Expect the Gelato call to fail until steps 2-4 above are
   fully correct; that's expected, not a bug. A Gelato 4xx is retried 5 times
   with backoff (~7.5 min in total), and only then does `/track/[orderId]`
   show `failed` with a clear message. Then it sends the Resend email if it
   gets that far. A timeout, 5xx or network error from Gelato is NOT
   auto-retried: the order may already exist there, so the job stops and asks
   for manual reconciliation (see `ensureSubmittedToGelato` in
   `apps/api/src/fulfillment.ts`).
7. Click "Track your order" and confirm the status timeline reflects what
   actually happened.

## 6. Deploying (out of scope for this checklist, flagged for later)

`apps/api` and `apps/web` both need public hosting before the Stripe/Gelato
webhook URLs above can point anywhere but `localhost`. Per prior project
notes, Railway/Render are reasonable options for `apps/api` (it already has
real Neon/Upstash/R2 credentials); `apps/web` is a standard Next.js app and
deploys cleanly to Vercel or similar. Every "going live" webhook step in §7
below needs this done first — a webhook can't point at `localhost`.

## 7. Going live — full production checklist, all three platforms

Everything up to here got you a *working, test-mode* integration. This
section is what actually turns it on for real customers and real money —
dashboard/account actions on each platform, not code.

### Stripe

1. **Complete business verification**: Dashboard → Settings → Business
   details. You'll need: legal business name, business type (individual or
   registered company), industry/category, business address, a tax ID (EIN,
   VAT number, or your country's equivalent), and the account
   representative's personal KYC details (legal name, date of birth, home
   address, and a government ID number — SSN/last-4 in the US, or your
   country's equivalent).
2. **Add a payout bank account**: Settings → Payouts → add your bank
   account. This is where your revenue lands, minus Stripe's fees.
3. Submit for review. Stripe often approves straightforward businesses
   quickly; higher-risk categories can take longer.
4. Once approved, the **Live mode** toggle (top-right) becomes fully usable.
   Switch to it and get your **live** keys from Developers → API keys:
   `sk_live_...` and `pk_live_...`.
5. Put the live keys in your **deployed** environment's env vars (Railway/
   Render for `apps/api`'s `STRIPE_SECRET_KEY`, Vercel or similar for
   `apps/web`'s `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`) — never in the local
   `.env` you've been testing with, and never committed to git.
6. Create a **new, Live-mode** webhook endpoint: Developers → Webhooks → Add
   endpoint → your deployed API's `https://yourdomain.com/api/webhooks/stripe`
   → subscribe to at least `payment_intent.succeeded`. This gives you a
   **new** `whsec_...` — different from the Stripe CLI one you've been using
   locally — put that in the deployed environment's `STRIPE_WEBHOOK_SECRET`.
7. Since checkout uses Stripe's own Payment Element (card data never touches
   your server), you qualify for Stripe's simplest PCI self-assessment
   (SAQ A) — Stripe's compliance dashboard will prompt for this if it's
   required for your account, usually a short form.
8. Do **one real transaction with your own card**, small amount, once
   deployed — confirm the charge appears in your bank payout and the whole
   webhook→order flow fires correctly against the live endpoint — before
   opening checkout to real customers.

### Gelato

1. **Complete company/billing information**: Gelato dashboard → Settings →
   Company (or Billing) — this is literally what blocked the test order I
   ran; nothing else in the integration is waiting on code.
2. **Add a payment method**: Billing → Payment methods → add a card. Gelato
   charges per order (not a subscription) — this card is billed each time
   your app successfully dispatches an order.
3. Review shipping regions/rates for wherever your book ships. The product
   UID already wired in (§2 above) has zero country restrictions, but
   confirm Gelato's actual shipping rates/timelines for your target markets
   match what you'll promise customers.
4. **Finalize the real page count** for your sellable book(s) — 28 minimum
   for the wired-in product. Update `apps/api/src/pipeline/catalog.ts`'s
   `pageIds` once you have real illustrated content at that length (this
   *is* a code change, but a content-driven one, not a config guess).
5. Once billing is set up, place **one real test order** — a real address
   (ship it to yourself), and watch it through to actual delivery. This
   confirms the full chain works end to end with real money, and gives you
   real production/shipping timelines to put in the confirmation
   email/page's "estimated delivery" copy (currently a placeholder
   "7-10 business days" in `apps/api/src/email/orderConfirmation.ts`).
6. Set `GELATO_WEBHOOK_SECRET` in your deployed environment and register the
   callback URL (`https://yourdomain.com/api/webhooks/gelato`) in their
   dashboard, configured to send that secret in the `x-gelato-webhook-secret`
   header. **Required:** without it the route rejects every status update
   (it fails closed), so orders would never move past "submitted to print".
   Confirm the header name against Gelato's real webhook config; it is still
   unverified. Make sure `GELATO_WEBHOOK_ALLOW_UNSIGNED` is unset in production.
7. Watch the first several real orders manually (Gelato's own dashboard +
   your `/track/[orderId]` pages) until you trust the automated flow.
8. Sanity-check margin: your book currently charges €34.90
   (`apps/api/src/pipeline/catalog.ts`'s `priceCents`) — confirm that covers
   Gelato's per-unit cost + shipping with room to spare, once you know real
   pricing for your finalized product/page-count.

### Resend

1. **Add and verify your sending domain**: Dashboard → Domains → Add Domain
   → add the SPF and DKIM DNS records it gives you at your domain's DNS
   provider (wherever you manage DNS for your domain — Cloudflare, your
   registrar, etc.). Verification can take minutes to hours.
2. Once verified, update `RESEND_FROM_ADDRESS` in your **deployed**
   environment to a real address at that domain (e.g. `orders@yourdomain.com`)
   — replacing the `onboarding@resend.dev` sandbox sender used for testing.
3. Send a real test email to an address **outside** your Resend account (a
   friend, a second personal email) to confirm it actually delivers and
   doesn't land in spam. If it does, double-check DKIM alignment in Resend's
   domain settings, and consider adding a DMARC record (start with
   `p=none` to just monitor, tighten later).
4. Check Resend's plan limits against your expected email volume — the free
   tier has a monthly send cap.

### Cross-cutting

- None of the Stripe/Gelato webhook steps above work until `apps/api` has a
  real public HTTPS URL — deploy first (§6).
- Every "live"/"production" key replaces its test-mode counterpart **only in
  the deployed environment's env vars** — keep the test keys in your local
  `.env` for continued local development.
- Do a full real walkthrough (real card, real address, real email) once
  everything above is done, before telling any customer this is live.

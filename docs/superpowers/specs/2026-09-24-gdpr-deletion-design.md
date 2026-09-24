# GDPR photo deletion: policy, design and inventory (Milestone 4, slices 1-3)

Status: **built 2026-09-24** (backend only; no UI). Migration `20260924100000_gdpr_deletion` is written but must be
applied with `npx prisma migrate deploy`. Automated deletion is **dry run** until `GDPR_DELETION_DRY_RUN=false`.

Prerequisites: [2026-09-23-milestone-4-gdpr-admin-prerequisites.md](2026-09-23-milestone-4-gdpr-admin-prerequisites.md).

## Policy (confirmed with the client)

| | Applies to | Deletes | When |
|---|---|---|---|
| **P1** | sessions with no paid order | raw uploads only | `now > session.expiresAt + 24h` |
| **P2a** | sessions on a delivered order | raw uploads | `now > order.deliveredAt + 24h` |
| **P2b** | sessions on a delivered order | processed files: rendered pages, preview, print PDF | `now > order.deliveredAt + 30 days` |
| **P3** | a logged-in customer, on request | everything, now; orders anonymised; account deleted | immediately |

Decisions made while building (2026-09-24):

- **"Paid order" for P1** means any order status other than `awaiting_payment` or `cancelled`. Checkout creates the
  Order row before payment, so the literal rule ("any order") would have kept every abandoned checkout's photos
  forever.
- **Rendered previews of unordered sessions are kept** (client decision). A later milestone will email reminders to
  order, then delete them. They show the child's face, so the privacy notice should say they're kept.
- **Held sessions.** A session with any order in `paid`, `pdf_ready`, `submitted_to_print`, `processing`,
  `dispatched` or `failed` is never swept: the book is still being made or shipped, or an admin may retry a failed
  one (which re-renders from the raw photo). This also covers a reorder of an already-delivered book. The P2 anchor
  is the **latest** `deliveredAt` across the session's orders.
- **`deliveredAt`** is set by the Gelato webhook the first time it maps to `delivered`
  (`updateMany ... where deliveredAt IS NULL`), so a re-sent webhook can't push deletion back. The migration
  backfills it from the first `delivered` status event (falling back to `updatedAt`). A `delivered` order with no
  `deliveredAt` is held, never guessed at.
- **P3 refuses (409)** while any order is `paid`, `pdf_ready`, `submitted_to_print` or `processing`, listing them.
  It also refuses (409) if an "abandoned" checkout's PaymentIntent turns out to have been paid (the webhook hasn't
  landed yet). It cancels the open PaymentIntents of abandoned checkouts first and returns 503 without deleting
  anything if Stripe can't confirm that, so a late payment can't charge for a book we can no longer make.
- **P3 anonymisation:**
  - `Order.email`, `shippingName`, `shippingLine1`, `shippingCity` and `shippingPostalCode` are set to `""`,
    `shippingLine2` is set to null, `customerId` is set to null, and `anonymisedAt` is stamped.
    `OrderItem.configSnapshot` becomes `[{slot, childName: "", rawKey: null}]` and `OrderStatusEvent.raw` becomes
    null (it held the Stripe event with `receipt_email`, and Gelato bodies that may include the address).
  - Kept: amounts, currency, status, items, titles, prices, timestamps, `stripePaymentIntentId`, and
    **`shippingCountry`** (VAT accounting).
  - `awaiting_payment` orders become `cancelled`, with a status event.
  - AuthToken, CustomerSession and the **Customer row are deleted**; the email is unique personal data.
- **P3 and shared sessions.** A session that another customer's order also references is left alone (reported as
  `sessionsKeptShared`) rather than destroying their book.
- **P3 can't see unordered previews.** `Session` has no `customerId`, so previews a customer never ordered are
  unlinkable to them. Their raw photos are removed by P1. Adding `Session.customerId` for logged-in visitors would
  close this.
- **Checkout slides the session expiry.** Otherwise P1 could delete the raw photo of a session that is ≥24h past
  expiry between order creation (still `awaiting_payment`) and payment.
- **Once a marker is set, the session is closed.** upload-url, upload-confirm and render-full answer 410 once
  `rawDeletedAt` or `processedDeletedAt` is set. Otherwise a re-upload would never be swept again, because the
  marker says it's done.

## Design

```
src/gdpr/
  schedule.ts            the policy: deletionSchedule(), isRawDue(), isProcessedDue(). Pure.
  deleteSessionAssets.ts the one deletion primitive (all pathways use it)
  candidates.ts          indexed SQL candidate queries + fresh per-session reads
  sweeper.ts             P1/P2: runGdprSweep()
  accountDeletion.ts     P3: deleteCustomerData(), customerDataStatus()
  notice.ts              the customer-facing wording (web copy: apps/web/lib/gdprNotice.ts)
src/gdprWorker.ts        BullMQ worker + job scheduler for the gdpr queue
scripts/gdpr-sweep.mts   one sweep now, no Redis (npm run gdpr:sweep)
test/seed-gdpr-demo.mts  end-to-end fixtures under sessions/gdpr-test-*
```

**`deleteSessionAssets(sessionId, { scope: raw|processed|all, trigger, actor, dryRun })`**

1. Collects keys two ways: by listing prefixes and from DB columns.
   - Listed prefixes: `sessions/<sid>/characters/` (raw), `sessions/<sid>/pages/` plus `orders/<oid>/items/<iid>/`
     for each of the session's order items (processed), or `sessions/<sid>/` plus the item prefixes (all).
   - DB columns: `Character.rawKey`, `configSnapshot[].rawKey`, `previewKey`, `printPageKeys`, `printPdfKey`.
2. Refuses any stored key outside the session's own prefixes, and any id that isn't `[A-Za-z0-9-]+` (an empty or
   `/`-containing id would widen the prefix).
3. For a dry run, writes the audit row with the would-be count and returns.
4. Otherwise: DeleteObjects in batches of 1000. Per-key errors count as failure. Then it re-lists; anything still
   present counts as failure. Only then does one transaction null the key columns, set
   `rawDeletedAt`/`processedDeletedAt` (keeping an earlier timestamp) and write the success audit row. On any
   failure it writes a failed audit row (with the number actually deleted) and rethrows, with the markers unset.
5. It is idempotent. It also works when the session row is gone (prefix-only), so re-runs after P3 succeed.

**Sweeper**, for each pathway:
1. Keyset-paginated SQL candidates (`GDPR_SWEEP_BATCH_SIZE`, at most `GDPR_SWEEP_MAX_PER_RUN` per pathway per run).
2. A fresh read of the session and **all** its orders, re-checked with `schedule.ts`. The SQL is only a pre-filter;
   the re-check is what prevents a wrong deletion (including a session paid for after the query ran).
3. `deleteSessionAssets` as `actor: "system"`.
4. Failures are logged by session id, counted, and the sweep continues. The BullMQ job fails at the end if anything
   failed, so it's kept for the admin dashboard.

`GDPR_DELETION_DRY_RUN` (anything but exactly `false`) forces a dry run.

**Queue.** The `gdpr` queue has one job scheduler, `gdpr-sweep`, every `GDPR_SWEEP_INTERVAL_MINUTES`. It uses
`attempts: 1` (the next run is the retry), `removeOnFail: false`, and keeps completed jobs for 7 days. The worker
runs at concurrency 1 in both `npm run dev` and `npm run worker`. BullMQ runs the first sweep as soon as the
scheduler is created.

**Audit log.** `DeletionAuditLog` holds: `createdAt`, `trigger` (`auto_p1` | `auto_p2_raw` | `auto_p2_processed` |
`user` | `admin`), `scope` (`raw` | `processed` | `all` | `account`), `sessionId` (no FK), `fileCount`, `actor`
(customerId or `"system"`), `dryRun`, `outcome`, `error`, and `force` (added with the admin API, migration
`20260924120000_admin_actions`). There's one row per `deleteSessionAssets` call, plus one `account` row per P3
request. It never holds an email, name or object key. The `admin` trigger is the admin override
(`POST /api/admin/deletions/sessions/:sessionId`, see apps/api/README.md), with `actor` = the admin's customer id.

**Dry-run volume.** Markers aren't set in a dry run, so every due session gets a new audit row on every sweep.
Existing sessions were backfilled with `createdAt + 72h`, so on an existing database most unordered sessions are
due on the first sweep.

## Inventory: where a customer's photo or derived image ends up

Verified against the code on 2026-09-24.

### R2

| Key | Class | Deleted by |
|---|---|---|
| `sessions/<sid>/characters/<cid>/raw.{jpg,png,webp}`. Up to three per character: each upload-url call can issue a different extension and only the confirmed one is in `rawKey`. | RAW | P1, P2a, P3 (prefix listing catches the unconfirmed ones) |
| `sessions/<sid>/pages/<pageId>.png`. The first page is also `Session.previewKey`. | PROCESSED | P2b, P3 |
| `orders/<oid>/items/<iid>/print.pdf`. Outside the session prefix; reached through `OrderItem.sessionId`. | PROCESSED | P2b, P3 |
| `scratch/<stage>/<uuid>.png`, `scratch/<stage>-out/<uuid>.png`. Stage inputs and outputs (child's face), only when `STAGE_EXECUTION=queued`. | PROCESSED | **Not deletable per customer** (random UUIDs, no DB link). Relies on a 1-day lifecycle rule on `scratch/` in the Cloudflare dashboard (`src/pipeline/queueStageRunner.ts`). **Confirm the rule exists.** |

### Database

| Column | Holds | Handled by |
|---|---|---|
| `Character.rawKey`, `Character.childName` | raw key, child's name | nulled (raw); row deleted (P3) |
| `Session.previewKey` | processed key | nulled (processed); row deleted (P3) |
| `OrderItem.configSnapshot` | copies of the raw key and child name | raw key nulled (raw); name blanked (P3) |
| `OrderItem.printPageKeys` | processed keys | left as-is: they only contain the session id, and the objects are gone |
| `OrderItem.printPdfKey` | processed key | nulled (processed, P3) |
| `Order` email / name / address | personal data | anonymised (P3); country kept |
| `Customer.email` | personal data | row deleted (P3) |
| `OrderStatusEvent.raw` | Stripe event (`receipt_email`), Gelato body (may hold the address), failure messages | nulled (P3) |

### Outside our reach, or not deleted by this work

- **Replicate.** Gets the raw photo as a 1-hour signed R2 URL (repaint, swap), intermediates as base64, and hosts
  the outputs. We don't store or log prediction ids and never call their delete API. Retention is Replicate's
  policy: API predictions are documented as removed after about an hour, which should be confirmed with Replicate.
  **We can't delete these ourselves.**
- **Gelato** keeps its own copy of the print PDF plus the shipping name and address. **Not deletable by us.**
- **Stripe** keeps `receipt_email` and `metadata.sessionIds` on the PaymentIntent. Not deleted.
- **Resend** keeps the recipient address and the email text (no images).
- **The repaint disk cache (production).** `src/pipeline/stages/repaint.ts` writes every repaint output, a
  picture of the child, to `<cwd>/.cache/repaint/<sha256>.png` on the worker. Nothing cleans it up, and it can't
  be traced to a session. **Not fixed here; recommended follow-up:** disable the cache outside the demo harnesses.
- **Developer machines.** `demo/output/` (CLI runs) and `homepage_local`'s in-memory job map. Not production.
- **Redis.** Failed pipeline and stage jobs are kept forever. Stage job data holds a signed raw-photo URL (it
  expires after 1h, but the key path stays). Fulfilment jobs hold only the order id.
- **Logs.**
  - `src/pipeline/retry.ts` logs the full URL on a 429, which can be a signed raw-photo URL.
  - `src/worker.ts` logs whole error objects, which can include Gelato error bodies echoing the address.
  - Fastify's request log records `magic-link/verify?token=…` (a login token, not a photo).
  - The new GDPR code logs session and customer ids only.
- **Browsers.** localStorage holds cart session ids; image caches may hold pages.

## Customer-facing wording

One sentence set, in `apps/api/src/gdpr/notice.ts` and `apps/web/lib/gdprNotice.ts`
(`test/unit/gdprNotice.test.ts` fails if they differ). It's used in the order confirmation email, the activation
email, the receipt PDF, `/confirmation`, `/set-password` and the checkout consent line:

> Your uploaded photos are deleted automatically 24 hours after your order is delivered. Your book's preview, page
> and print files are deleted 30 days after delivery. If you don't place an order, your photos are deleted 24 hours
> after your preview expires.

## Environment

| Var | Default | |
|---|---|---|
| `GDPR_DELETION_DRY_RUN` | `true` (in code and `.env.example`) | only exactly `false` enables real automated deletion |
| `GDPR_SWEEP_INTERVAL_MINUTES` | 60 | sweep frequency |
| `GDPR_SWEEP_BATCH_SIZE` | 50 | candidates per query |
| `GDPR_SWEEP_MAX_PER_RUN` | 1000 | per pathway per run |
| `RL_MY_DATA_IP_MAX` / `RL_MY_DATA_WINDOW_MIN` | 5 / 60 | `DELETE /api/account/my-data` per IP (every attempt counts) |

## Built later (2026-09-24, Milestone 4 slices 4-5)

- The `/account` My Data tab (reads `GET /api/account/my-data`, which now also returns each item's `pathway`).
- The admin override by session id and the rest of the admin API (apps/api/README.md, "Admin role and admin
  API"). The override refuses (409) a session held by an order in production unless `force: true`, which is
  recorded in the audit row.

## Not built (later sessions)

- `/admin` pages (slice 6).
- Reminder emails before deleting unordered previews.

# Milestone 4: GDPR compliance & admin dashboard (scope + prerequisites)

Status: **prerequisites done (2026-09-23). GDPR deletion backend (Pathways 1-3, audit log) built 2026-09-24**, see
[2026-09-24-gdpr-deletion-design.md](2026-09-24-gdpr-deletion-design.md), which also resolves the "Gaps noticed"
below. The admin deletion override, `/account` My Data tab and `/admin` were built the same day (slices 4-6); see
apps/api/README.md ("Admin role and admin API") and apps/web/README.md.

## Scope (as agreed with the client)

**Backend**
- GDPR photo deletion, **Pathway 1**: a cron job deletes raw uploads 24h after session expiry.
- GDPR photo deletion, **Pathway 2**: processed assets deleted 30 days after Gelato delivery confirmation.
- GDPR photo deletion, **Pathway 3**: user-triggered `DELETE /account/my-data` cascades across R2 storage and
  all database records. Immediate and irreversible.
- Full deletion audit log: timestamp, trigger type (auto/user), session ID, file count. Written on every
  deletion event.
- Manual photo deletion override in admin (by session ID).

**Frontend**
- `/account` → My Data tab: photo status per order, deletion schedule, "delete now" button, confirmation modal.
- `/admin`, the full internal dashboard:
  - Queue monitor: BullMQ job list (active, waiting, completed, failed) with per-job detail.
  - Failed job inspector: error log, stack trace, retry button.
  - Order tracker: all orders, status update controls, Gelato status sync.
  - Storage: R2 usage by category, file list per session.
  - Photo deletion: scheduled queue, manual override by session ID, full audit log.

## Prerequisites in place

| Need | What exists now | Where |
|---|---|---|
| Pathway 1 needs a session expiry | `Session.expiresAt` (sliding, `SESSION_TTL_HOURS`, default 72) and `Session.lastActivityAt`. Set at creation, pushed forward by upload-confirm and render-full. Indexed. | `prisma/schema.prisma`, `src/sessionExpiry.ts` |
| `/admin` needs an authorisation boundary | `Customer.role` (`customer` \| `admin`) and `requireAdmin()` (401 when not logged in, 403 when not an admin). No API route can grant the role; only the `npm run make-admin -- <email>` CLI can. | `src/auth/guard.ts`, `scripts/make-admin.mts` |
| Failed job inspector / retry button | Fulfilment is a BullMQ job (`fulfillment` queue, `jobId` = order id, 5 attempts, failed jobs kept). Every step is idempotent, so "retry" is safe: a job retry re-runs from the start and skips finished steps. | `src/queue.ts`, `src/fulfillment.ts`, `src/fulfillmentWorker.ts` |
| Raw uploads are only ever our own keys | upload-confirm only accepts `sessions/<id>/characters/<charId>/raw.<jpg\|png\|webp>`, and only once the object exists, so the deletion jobs can rely on that key layout. | `src/storage.ts` (`isIssuedRawObjectKey`) |

## Rule: sessions attached to an order never expire for deletion

A session referenced by **any** `OrderItem.sessionId` is never "expired" for Pathway 1 purposes, whatever its
`expiresAt` says. Its photos are governed by Pathway 2 (after delivery) and Pathway 3 (user request) instead.
Deleting a paid customer's raw photo 24h after the preview would break re-rendering and reprints.

`OrderItem.sessionId` has **no foreign key** to `Session`, so the Pathway 1 sweeper must exclude these with an
explicit query (e.g. `NOT EXISTS (SELECT 1 FROM "OrderItem" oi WHERE oi."sessionId" = s.id)`). A relation
won't do it.

## Gaps noticed (for Milestone 4 to decide, not fixed)

- **Pathway 3 can't find a customer's sessions directly.** `Session` has no `customerId`. The only link is
  `Customer → Order → OrderItem.sessionId`. Sessions a customer previewed but never bought are unlinkable to
  them.
- **Pathway 2 has no delivery timestamp.** Delivery is only an `OrderStatusEvent` row (`status = delivered`,
  source `gelato_webhook`), and the Gelato status vocabulary in `src/orderStatus.ts` is still unverified against
  a real webhook. A `deliveredAt` column (or a query on the event) is needed.
- **No cascades for deletion.** `Character → Session` and `OrderItem/OrderStatusEvent → Order` have no
  `onDelete: Cascade`, so row deletion must be ordered by hand, or the relations changed.
- **Existing sessions were backfilled with createdAt + 72h**, so once Pathway 1 ships, most pre-existing preview
  sessions will already be past expiry and their raw uploads deleted on the first sweep (unless ordered).
  That is probably desired, but confirm it with the client.
- **Session TTL (72h) is a placeholder** pending client confirmation.

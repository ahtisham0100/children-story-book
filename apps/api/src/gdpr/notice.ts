/**
 * The customer-facing deletion promise. Must match src/gdpr/schedule.ts and
 * the web copy in apps/web/lib/gdprNotice.ts EXACTLY; test/unit/gdprNotice.test.ts
 * fails if the two copies drift. Used by the order confirmation email, the
 * account activation email and the receipt PDF.
 */
export const GDPR_DELETION_NOTICE =
  "Your uploaded photos are deleted automatically 24 hours after your order is delivered. " +
  "Your book's preview, page and print files are deleted 30 days after delivery. " +
  "If you don't place an order, your photos are deleted 24 hours after your preview expires.";

// The customer-facing deletion promise, shown on /confirmation and
// /set-password. Must match apps/api/src/gdpr/notice.ts EXACTLY (the API's
// emails and receipt use that copy); apps/api/test/unit/gdprNotice.test.ts
// fails if the two drift. The policy itself lives in apps/api/src/gdpr/schedule.ts.
export const GDPR_DELETION_NOTICE =
  "Your uploaded photos are deleted automatically 24 hours after your order is delivered. " +
  "Your book's preview, page and print files are deleted 30 days after delivery. " +
  "If you don't place an order, your photos are deleted 24 hours after your preview expires.";

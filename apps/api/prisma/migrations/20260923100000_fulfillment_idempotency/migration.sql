-- Fulfilment idempotency markers: fulfilment now runs as a retryable BullMQ
-- job, and each step checks these to skip work a previous attempt finished.
ALTER TABLE "Order" ADD COLUMN "gelatoSubmitStartedAt" TIMESTAMP(3),
ADD COLUMN "confirmationEmailSentAt" TIMESTAMP(3),
ADD COLUMN "activationEmailSentAt" TIMESTAMP(3);

-- Backfill: the old in-process fulfilment sent both emails immediately after
-- storing gelatoOrderId, so an order that already has one went through that
-- path. Marking them as sent (with updatedAt as a best-available timestamp)
-- stops a future re-run of fulfilment for such an order from re-emailing the
-- customer.
UPDATE "Order"
SET "confirmationEmailSentAt" = "updatedAt",
    "activationEmailSentAt" = "updatedAt"
WHERE "gelatoOrderId" IS NOT NULL;

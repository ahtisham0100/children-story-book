-- GDPR photo deletion (Milestone 4, slices 1-3). See
-- docs/superpowers/specs/2026-09-24-gdpr-deletion-design.md.

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "processedDeletedAt" TIMESTAMP(3),
ADD COLUMN     "rawDeletedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "anonymisedAt" TIMESTAMP(3),
ADD COLUMN     "deliveredAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "DeletionAuditLog" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "trigger" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "sessionId" TEXT,
    "fileCount" INTEGER NOT NULL,
    "actor" TEXT NOT NULL,
    "dryRun" BOOLEAN NOT NULL,
    "outcome" TEXT NOT NULL,
    "error" TEXT,

    CONSTRAINT "DeletionAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeletionAuditLog_createdAt_idx" ON "DeletionAuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "DeletionAuditLog_sessionId_idx" ON "DeletionAuditLog"("sessionId");

-- CreateIndex
CREATE INDEX "Order_deliveredAt_idx" ON "Order"("deliveredAt");

-- CreateIndex
CREATE INDEX "OrderItem_sessionId_idx" ON "OrderItem"("sessionId");


-- Backfill deliveredAt for orders that are already delivered: the first
-- "delivered" status event, falling back to updatedAt if no event exists (an
-- order can't be swept by Pathway 2 without an anchor). Pathway 2 deletes raw
-- photos 24h after this, so already-delivered orders become due on the first
-- sweep that runs after this migration.
UPDATE "Order" o
SET "deliveredAt" = COALESCE(
  (SELECT MIN(e."createdAt") FROM "OrderStatusEvent" e
    WHERE e."orderId" = o.id AND e.status = 'delivered'),
  o."updatedAt"
)
WHERE o.status = 'delivered' AND o."deliveredAt" IS NULL;

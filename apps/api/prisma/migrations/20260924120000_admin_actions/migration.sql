-- AlterTable
ALTER TABLE "DeletionAuditLog" ADD COLUMN     "force" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "AdminActionLog" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "adminId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "note" TEXT,

    CONSTRAINT "AdminActionLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdminActionLog_createdAt_idx" ON "AdminActionLog"("createdAt");

-- CreateIndex
CREATE INDEX "AdminActionLog_targetType_targetId_idx" ON "AdminActionLog"("targetType", "targetId");


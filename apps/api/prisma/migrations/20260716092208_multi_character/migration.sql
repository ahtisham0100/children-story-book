-- DropIndex
DROP INDEX "Character_sessionId_key";

-- AlterTable
ALTER TABLE "Character" DROP COLUMN "previewKey",
DROP COLUMN "role",
ADD COLUMN     "childName" TEXT NOT NULL,
ADD COLUMN     "slot" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Session" DROP COLUMN "childName",
ADD COLUMN     "previewKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Character_sessionId_slot_key" ON "Character"("sessionId", "slot");


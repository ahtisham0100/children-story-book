-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'fr',
    "storyId" TEXT NOT NULL,
    "childName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'created',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Character" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'child',
    "rawKey" TEXT,
    "noBgKey" TEXT,
    "skinToneHex" TEXT,
    "portraitKey" TEXT,
    "previewKey" TEXT,
    "jobId" TEXT,

    CONSTRAINT "Character_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Character_sessionId_key" ON "Character"("sessionId");

-- AddForeignKey
ALTER TABLE "Character" ADD CONSTRAINT "Character_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

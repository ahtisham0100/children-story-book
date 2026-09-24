-- Session expiry, prerequisite for GDPR deletion Pathway 1 (Milestone 4).
-- Added nullable, backfilled, then made NOT NULL so existing rows are valid.
ALTER TABLE "Session" ADD COLUMN "expiresAt" TIMESTAMP(3),
ADD COLUMN "lastActivityAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP;

-- Backfill uses the DEFAULT TTL of 72 hours (SESSION_TTL_HOURS's default).
-- It's hardcoded because a migration can't read the app's env. If production
-- runs a different TTL, existing sessions keep createdAt + 72h until their
-- next activity.
UPDATE "Session"
SET "expiresAt" = "createdAt" + INTERVAL '72 hours',
    "lastActivityAt" = "createdAt";

ALTER TABLE "Session" ALTER COLUMN "expiresAt" SET NOT NULL,
ALTER COLUMN "lastActivityAt" SET NOT NULL;

-- For the future expiry sweeper's range scan.
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

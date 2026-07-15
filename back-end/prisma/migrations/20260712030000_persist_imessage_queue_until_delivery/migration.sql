-- Approved iMessages must remain durable while the user's Mac relay is offline.
-- Preserve explicit legacy expirations only for already-terminal receipts; every
-- still-pending row becomes eligible for delivery when the Mac returns.
ALTER TABLE "ImessageQueue"
  ALTER COLUMN "expiresAt" DROP DEFAULT,
  ALTER COLUMN "expiresAt" DROP NOT NULL;

UPDATE "ImessageQueue"
SET "expiresAt" = NULL
WHERE "sentAt" IS NULL
  AND "failedAt" IS NULL
  AND "dispatchedAt" IS NULL;

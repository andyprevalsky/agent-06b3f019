ALTER TABLE "ImessageQueue"
ADD COLUMN "claimedAt" TIMESTAMP(3),
ADD COLUMN "claimToken" TEXT,
ADD COLUMN "dispatchedAt" TIMESTAMP(3),
ADD COLUMN "sentAt" TIMESTAMP(3),
ADD COLUMN "expiresAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL '1 minute'),
ADD COLUMN "failedAt" TIMESTAMP(3),
ADD COLUMN "lastError" TEXT,
ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "failures" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "ImessageQueue_send_claim_idx"
ON "ImessageQueue"("userId", "sentAt", "failedAt", "dispatchedAt", "expiresAt", "claimedAt", "createdAt");

ALTER TABLE "User"
ADD COLUMN "imessageBridgeLastSeenAt" TIMESTAMP(3);

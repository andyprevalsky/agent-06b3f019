ALTER TABLE "MessageRecord" ADD COLUMN "googleAccountEmail" TEXT;

CREATE TABLE "GoogleDataPurge" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedUntil" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GoogleDataPurge_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "GoogleDataPurge_processedAt_claimedUntil_requestedAt_idx" ON "GoogleDataPurge"("processedAt", "claimedUntil", "requestedAt");
CREATE INDEX "GoogleDataPurge_userId_email_idx" ON "GoogleDataPurge"("userId", "email");
CREATE INDEX "MessageRecord_googleAccountEmail_createdAt_idx" ON "MessageRecord"("googleAccountEmail", "createdAt");

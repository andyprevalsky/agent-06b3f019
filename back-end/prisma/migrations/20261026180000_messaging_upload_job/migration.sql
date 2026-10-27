-- CreateTable
CREATE TABLE "MessagingUploadJob" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "uploadId" TEXT NOT NULL,
    "part" INTEGER NOT NULL,
    "parts" INTEGER NOT NULL,
    "payload" JSONB,
    "accessedAt" TEXT,
    "syncComplete" BOOLEAN NOT NULL DEFAULT true,
    "contacts" INTEGER NOT NULL,
    "messages" INTEGER NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "claimedUntil" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessagingUploadJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MessagingUploadJob_processedAt_failedAt_claimedUntil_create_idx" ON "MessagingUploadJob"("processedAt", "failedAt", "claimedUntil", "createdAt");

-- CreateIndex
CREATE INDEX "MessagingUploadJob_userId_createdAt_idx" ON "MessagingUploadJob"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MessagingUploadJob_uploadId_part_key" ON "MessagingUploadJob"("uploadId", "part");


-- Service-role access only (written and drained by the backend, never by clients).
ALTER TABLE "MessagingUploadJob" ENABLE ROW LEVEL SECURITY;

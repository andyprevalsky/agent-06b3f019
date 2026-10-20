-- CreateTable
CREATE TABLE "IntegrationSyncProgress" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "accountId" TEXT NOT NULL DEFAULT '',
    "runId" TEXT NOT NULL,
    "retiredRunIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "seq" INTEGER NOT NULL DEFAULT 0,
    "state" TEXT NOT NULL DEFAULT 'idle',
    "phase" TEXT,
    "done" BIGINT,
    "total" BIGINT,
    "pct" DOUBLE PRECISION,
    "unit" TEXT,
    "etaSec" INTEGER,
    "lastError" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationSyncProgress_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IntegrationSyncProgress_userId_updatedAt_idx" ON "IntegrationSyncProgress"("userId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationSyncProgress_userId_provider_accountId_key" ON "IntegrationSyncProgress"("userId", "provider", "accountId");

-- Per-user scoping mirrors Integration: clients only ever read their own rows;
-- the backend (service role) owns every write.
ALTER TABLE "IntegrationSyncProgress" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can select own data" ON "IntegrationSyncProgress" FOR SELECT USING (((auth.uid())::text = "userId"));

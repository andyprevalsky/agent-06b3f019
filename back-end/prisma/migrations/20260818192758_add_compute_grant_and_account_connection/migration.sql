-- CreateTable
CREATE TABLE "ComputeAccountConnection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "accountEmail" TEXT,
    "encryptedSession" TEXT,
    "state" TEXT NOT NULL DEFAULT 'connected',
    "sessionExpiresAt" TIMESTAMP(3),
    "lastErrorReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComputeAccountConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComputeGrant" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "surface" TEXT NOT NULL DEFAULT 'cloud',
    "grantType" TEXT NOT NULL,
    "encryptedCredentials" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "deadReason" TEXT,
    "expiresAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "mintedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "diedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComputeGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ComputeAccountConnection_userId_provider_idx" ON "ComputeAccountConnection"("userId", "provider");

-- CreateIndex
CREATE INDEX "ComputeAccountConnection_state_idx" ON "ComputeAccountConnection"("state");

-- CreateIndex
CREATE UNIQUE INDEX "ComputeAccountConnection_userId_provider_accountId_key" ON "ComputeAccountConnection"("userId", "provider", "accountId");

-- CreateIndex
CREATE INDEX "ComputeGrant_userId_provider_status_idx" ON "ComputeGrant"("userId", "provider", "status");

-- CreateIndex
CREATE INDEX "ComputeGrant_connectionId_status_idx" ON "ComputeGrant"("connectionId", "status");

-- CreateIndex
CREATE INDEX "ComputeGrant_accountId_idx" ON "ComputeGrant"("accountId");

-- CreateIndex
CREATE INDEX "ComputeGrant_status_expiresAt_idx" ON "ComputeGrant"("status", "expiresAt");

-- AddForeignKey
ALTER TABLE "ComputeGrant" ADD CONSTRAINT "ComputeGrant_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "ComputeAccountConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;


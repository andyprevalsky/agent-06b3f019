ALTER TYPE "PurchaseSpendStatus" ADD VALUE IF NOT EXISTS 'CAPTURE_FAILED';
ALTER TYPE "PurchaseSpendStatus" ADD VALUE IF NOT EXISTS 'FUNDING_RECLAIM_FAILED';

CREATE TYPE "PurchaseWalletFundingStatus" AS ENUM (
  'PENDING',
  'FUNDED',
  'CONSUMED',
  'RECLAIMING',
  'RECLAIMED',
  'FAILED',
  'RECLAIM_FAILED'
);

CREATE TABLE "PurchaseWalletFunding" (
  "id" TEXT NOT NULL,
  "purchaseId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "agentId" TEXT,
  "provider" TEXT NOT NULL DEFAULT 'agentcard',
  "amountCents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'usd',
  "status" "PurchaseWalletFundingStatus" NOT NULL DEFAULT 'PENDING',
  "providerTransferId" TEXT,
  "reclaimProviderTransferId" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "reclaimIdempotencyKey" TEXT,
  "metadata" JSONB,
  "errorMessage" TEXT,
  "fundedAt" TIMESTAMP(3),
  "consumedAt" TIMESTAMP(3),
  "reclaimedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PurchaseWalletFunding_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PurchaseWalletFunding_purchaseId_key" ON "PurchaseWalletFunding"("purchaseId");
CREATE UNIQUE INDEX "PurchaseWalletFunding_idempotencyKey_key" ON "PurchaseWalletFunding"("idempotencyKey");
CREATE INDEX "PurchaseWalletFunding_userId_status_idx" ON "PurchaseWalletFunding"("userId", "status");
CREATE INDEX "PurchaseWalletFunding_agentId_idx" ON "PurchaseWalletFunding"("agentId");
CREATE INDEX "PurchaseWalletFunding_status_createdAt_idx" ON "PurchaseWalletFunding"("status", "createdAt");

ALTER TABLE "PurchaseWalletFunding" ADD CONSTRAINT "PurchaseWalletFunding_purchaseId_fkey"
  FOREIGN KEY ("purchaseId") REFERENCES "PurchaseSpend"("id") ON DELETE CASCADE ON UPDATE CASCADE;

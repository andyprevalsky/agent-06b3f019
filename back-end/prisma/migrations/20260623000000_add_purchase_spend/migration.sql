CREATE TYPE "PurchaseSpendStatus" AS ENUM (
  'PENDING_APPROVAL',
  'CHARGING',
  'HELD',
  'CLEARED',
  'VOIDED',
  'REFUNDED',
  'FAILED'
);

CREATE TABLE "PurchaseSpend" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "agentId" TEXT,
  "fingerprint" TEXT NOT NULL,
  "cardId" TEXT,
  "merchant" TEXT NOT NULL,
  "lineItemsJson" JSONB NOT NULL,
  "totalCents" INTEGER NOT NULL,
  "status" "PurchaseSpendStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
  "stripePaymentIntentId" TEXT,
  "provider" TEXT NOT NULL DEFAULT 'agentcard',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PurchaseSpend_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PurchaseSpend_userId_fingerprint_key" ON "PurchaseSpend"("userId", "fingerprint");
CREATE INDEX "PurchaseSpend_agentId_idx" ON "PurchaseSpend"("agentId");
CREATE INDEX "PurchaseSpend_cardId_idx" ON "PurchaseSpend"("cardId");
CREATE INDEX "PurchaseSpend_status_idx" ON "PurchaseSpend"("status");
CREATE INDEX "PurchaseSpend_createdAt_idx" ON "PurchaseSpend"("createdAt");

ALTER TABLE "PurchaseSpend" ADD CONSTRAINT "PurchaseSpend_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PurchaseSpend" ADD CONSTRAINT "PurchaseSpend_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Plaid Transactions Sync normalized storage.
-- Stores searchable transaction fields only; raw Plaid payloads are not stored.

CREATE TYPE "TransactionDirection" AS ENUM ('OUTFLOW', 'INFLOW');

CREATE TABLE "PlaidTransaction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "plaidItemId" TEXT NOT NULL,
    "plaidAccountId" TEXT NOT NULL,
    "plaidTransactionId" TEXT NOT NULL,
    "plaidAccountExternalId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "authorizedDate" TIMESTAMP(3),
    "datetime" TIMESTAMP(3),
    "authorizedDatetime" TIMESTAMP(3),
    "name" TEXT NOT NULL,
    "merchantName" TEXT,
    "originalDescription" TEXT,
    "amount" DECIMAL(18,4) NOT NULL,
    "absoluteAmount" DECIMAL(18,4) NOT NULL,
    "direction" "TransactionDirection" NOT NULL,
    "isoCurrencyCode" TEXT,
    "unofficialCurrencyCode" TEXT,
    "category" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "categoryId" TEXT,
    "personalFinanceCategory" TEXT,
    "personalFinanceDetailed" TEXT,
    "paymentChannel" TEXT,
    "locationSummary" TEXT,
    "pending" BOOLEAN NOT NULL DEFAULT false,
    "pendingTransactionId" TEXT,
    "accountOwner" TEXT,
    "checkNumber" TEXT,
    "removedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlaidTransaction_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlaidTransaction_plaidTransactionId_key" ON "PlaidTransaction"("plaidTransactionId");
CREATE INDEX "PlaidTransaction_userId_date_idx" ON "PlaidTransaction"("userId", "date");
CREATE INDEX "PlaidTransaction_userId_pending_idx" ON "PlaidTransaction"("userId", "pending");
CREATE INDEX "PlaidTransaction_userId_removedAt_idx" ON "PlaidTransaction"("userId", "removedAt");
CREATE INDEX "PlaidTransaction_plaidItemId_idx" ON "PlaidTransaction"("plaidItemId");
CREATE INDEX "PlaidTransaction_plaidAccountId_idx" ON "PlaidTransaction"("plaidAccountId");
CREATE INDEX "PlaidTransaction_plaidAccountExternalId_idx" ON "PlaidTransaction"("plaidAccountExternalId");

ALTER TABLE "PlaidTransaction"
  ADD CONSTRAINT "PlaidTransaction_plaidItemId_fkey"
  FOREIGN KEY ("plaidItemId") REFERENCES "PlaidItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PlaidTransaction"
  ADD CONSTRAINT "PlaidTransaction_plaidAccountId_fkey"
  FOREIGN KEY ("plaidAccountId") REFERENCES "PlaidAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PlaidTransaction" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "PlaidTransaction_select_own" ON "PlaidTransaction"
  FOR SELECT
  USING ("userId" = (current_setting('request.jwt.claims', true)::json ->> 'sub'));

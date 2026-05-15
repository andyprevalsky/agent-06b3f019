-- Plaid integration tables.
-- PlaidItem: one connected institution per user; access_token stored as
-- AES-256-GCM + RSA-OAEP-SHA256 envelope (see providers/plaidCredentials.ts).
-- PlaidAccount: per-account metadata (no balances/transactions persisted).

-- PlaidItemStatus enum
CREATE TYPE "PlaidItemStatus" AS ENUM ('ACTIVE', 'DISCONNECTED', 'REQUIRES_REAUTH', 'ERROR');

-- PlaidItem table
CREATE TABLE "PlaidItem" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "plaidItemId" TEXT NOT NULL,
    "plaidInstitutionId" TEXT,
    "institutionName" TEXT,
    "encryptedAccessToken" TEXT NOT NULL,
    "status" "PlaidItemStatus" NOT NULL DEFAULT 'ACTIVE',
    "products" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "cursor" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "lastWebhookAt" TIMESTAMP(3),
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "disconnectedAt" TIMESTAMP(3),

    CONSTRAINT "PlaidItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlaidItem_plaidItemId_key" ON "PlaidItem"("plaidItemId");
CREATE INDEX "PlaidItem_userId_idx" ON "PlaidItem"("userId");
CREATE INDEX "PlaidItem_userId_status_idx" ON "PlaidItem"("userId", "status");
CREATE INDEX "PlaidItem_integrationId_idx" ON "PlaidItem"("integrationId");

ALTER TABLE "PlaidItem"
  ADD CONSTRAINT "PlaidItem_integrationId_fkey"
  FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- PlaidAccount table
CREATE TABLE "PlaidAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "plaidItemId" TEXT NOT NULL,
    "plaidAccountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "officialName" TEXT,
    "mask" TEXT,
    "type" TEXT NOT NULL,
    "subtype" TEXT,
    "verificationStatus" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "disconnectedAt" TIMESTAMP(3),

    CONSTRAINT "PlaidAccount_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlaidAccount_plaidAccountId_key" ON "PlaidAccount"("plaidAccountId");
CREATE INDEX "PlaidAccount_userId_idx" ON "PlaidAccount"("userId");
CREATE INDEX "PlaidAccount_plaidItemId_idx" ON "PlaidAccount"("plaidItemId");

ALTER TABLE "PlaidAccount"
  ADD CONSTRAINT "PlaidAccount_plaidItemId_fkey"
  FOREIGN KEY ("plaidItemId") REFERENCES "PlaidItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security: users see only their own rows; backend service role
-- bypasses for administrative writes (matches the policy described in
-- docs/legal/rose-labs-information-security-policy.md §5).
ALTER TABLE "PlaidItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PlaidAccount" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "PlaidItem_select_own" ON "PlaidItem"
  FOR SELECT
  USING ("userId" = (current_setting('request.jwt.claims', true)::json ->> 'sub'));

CREATE POLICY "PlaidAccount_select_own" ON "PlaidAccount"
  FOR SELECT
  USING ("userId" = (current_setting('request.jwt.claims', true)::json ->> 'sub'));

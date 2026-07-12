ALTER TABLE "BrowserSession"
ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'steel';

CREATE TABLE "BrowserProviderProfile" (
    "id" TEXT NOT NULL,
    "contextId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrowserProviderProfile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BrowserProviderProfile_contextId_provider_key"
ON "BrowserProviderProfile"("contextId", "provider");

CREATE UNIQUE INDEX "BrowserProviderProfile_provider_profileId_key"
ON "BrowserProviderProfile"("provider", "profileId");

CREATE INDEX "BrowserProviderProfile_contextId_idx"
ON "BrowserProviderProfile"("contextId");

ALTER TABLE "BrowserProviderProfile"
ADD CONSTRAINT "BrowserProviderProfile_contextId_fkey"
FOREIGN KEY ("contextId") REFERENCES "BrowserContext"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "BrowserProviderProxy" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "proxyKey" TEXT NOT NULL,
    "proxyId" TEXT NOT NULL,
    "proxyType" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrowserProviderProxy_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BrowserProviderProxy_provider_proxyKey_key"
ON "BrowserProviderProxy"("provider", "proxyKey");

CREATE UNIQUE INDEX "BrowserProviderProxy_provider_proxyId_key"
ON "BrowserProviderProxy"("provider", "proxyId");

CREATE INDEX "BrowserProviderProxy_provider_idx"
ON "BrowserProviderProxy"("provider");

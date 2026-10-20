-- Root browser world state split by website (plan row A6).
-- BrowserSiteState: Root's per-site head (one row per user and registrable
-- domain). BrowserSiteFork: which sites a browser task forked from Root, the
-- base it forked, and its merge outcome. Both are new tables, so creating them
-- touches no existing rows.

-- CreateTable
CREATE TABLE "BrowserSiteState" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "site" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "authFingerprint" TEXT NOT NULL DEFAULT '',
    "cookieCount" INTEGER NOT NULL DEFAULT 0,
    "lastWriterTaskId" TEXT,
    "lastWriterAgentId" TEXT,
    "lastWriterKind" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrowserSiteState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrowserSiteFork" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "browserSessionId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "site" TEXT NOT NULL,
    "baseRevision" INTEGER NOT NULL,
    "baseFingerprint" TEXT NOT NULL,
    "baseAuthKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "mergedRevision" INTEGER,
    "lastOutcome" TEXT,
    "forkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mergedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrowserSiteFork_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BrowserSiteState_userId_site_key" ON "BrowserSiteState"("userId", "site");

-- CreateIndex
CREATE INDEX "BrowserSiteFork_userId_agentId_idx" ON "BrowserSiteFork"("userId", "agentId");

-- CreateIndex
CREATE UNIQUE INDEX "BrowserSiteFork_browserSessionId_site_key" ON "BrowserSiteFork"("browserSessionId", "site");

-- AddForeignKey
ALTER TABLE "BrowserSiteState" ADD CONSTRAINT "BrowserSiteState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrowserSiteFork" ADD CONSTRAINT "BrowserSiteFork_browserSessionId_fkey" FOREIGN KEY ("browserSessionId") REFERENCES "BrowserSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backend-only bookkeeping: the service role owns every read and write (the
-- web client goes through the authenticated API), so no client policy is
-- granted.
ALTER TABLE "BrowserSiteState" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BrowserSiteFork" ENABLE ROW LEVEL SECURITY;

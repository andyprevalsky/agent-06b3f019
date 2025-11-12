-- CreateEnum
CREATE TYPE "BrowserSessionStatus" AS ENUM ('ACTIVE', 'CLOSED', 'ERROR');

-- CreateTable
CREATE TABLE "BrowserContext" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "contextId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrowserContext_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrowserSession" (
    "id" TEXT NOT NULL,
    "contextId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "status" "BrowserSessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "debugUrl" TEXT,
    "currentUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "BrowserSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BrowserContext_userId_key" ON "BrowserContext"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "BrowserContext_contextId_key" ON "BrowserContext"("contextId");

-- CreateIndex
CREATE INDEX "BrowserContext_userId_idx" ON "BrowserContext"("userId");

-- CreateIndex
CREATE INDEX "BrowserContext_contextId_idx" ON "BrowserContext"("contextId");

-- CreateIndex
CREATE UNIQUE INDEX "BrowserSession_sessionId_key" ON "BrowserSession"("sessionId");

-- CreateIndex
CREATE INDEX "BrowserSession_contextId_idx" ON "BrowserSession"("contextId");

-- CreateIndex
CREATE INDEX "BrowserSession_agentId_idx" ON "BrowserSession"("agentId");

-- CreateIndex
CREATE INDEX "BrowserSession_sessionId_idx" ON "BrowserSession"("sessionId");

-- CreateIndex
CREATE INDEX "BrowserSession_status_idx" ON "BrowserSession"("status");

-- AddForeignKey
ALTER TABLE "BrowserSession" ADD CONSTRAINT "BrowserSession_contextId_fkey" FOREIGN KEY ("contextId") REFERENCES "BrowserContext"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Add inviteCode columns to User table
ALTER TABLE "User" ADD COLUMN "inviteCode" TEXT;
ALTER TABLE "User" ADD COLUMN "inviteCodeUses" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "usedInviteCode" TEXT;

CREATE UNIQUE INDEX "User_inviteCode_key" ON "User"("inviteCode");
CREATE INDEX "User_inviteCode_idx" ON "User"("inviteCode");
CREATE INDEX "User_usedInviteCode_idx" ON "User"("usedInviteCode");

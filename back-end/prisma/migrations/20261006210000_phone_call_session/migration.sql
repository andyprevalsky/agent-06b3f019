-- CreateTable
CREATE TABLE "PhoneCallSession" (
    "id" TEXT NOT NULL,
    "operationKey" TEXT,
    "agentId" TEXT,
    "userId" TEXT,
    "rootVapiCallId" TEXT,
    "activeVapiCallId" TEXT,
    "twilioCallSid" TEXT,
    "phoneNumberId" TEXT NOT NULL,
    "fromNumber" TEXT NOT NULL,
    "toNumber" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'dialing',
    "assistantConfig" JSONB NOT NULL,
    "segments" JSONB NOT NULL DEFAULT '[]',
    "holds" JSONB NOT NULL DEFAULT '[]',
    "endedReason" TEXT,
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PhoneCallSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PhoneCallSession_rootVapiCallId_key" ON "PhoneCallSession"("rootVapiCallId");

-- CreateIndex
CREATE UNIQUE INDEX "PhoneCallSession_twilioCallSid_key" ON "PhoneCallSession"("twilioCallSid");

-- CreateIndex
CREATE INDEX "PhoneCallSession_agentId_idx" ON "PhoneCallSession"("agentId");

-- Service-role access only (written by backend webhooks, never by clients).
ALTER TABLE "PhoneCallSession" ENABLE ROW LEVEL SECURITY;

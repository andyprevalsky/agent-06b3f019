-- CreateTable
CREATE TABLE "IPhoneDevice" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "providerDeviceId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "setupState" TEXT NOT NULL DEFAULT 'not_started',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IPhoneDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IPhoneLease" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "browserTaskId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'WAITING',
    "ticket" BIGSERIAL NOT NULL,
    "activeDeviceId" TEXT,
    "queueDeadlineAt" TIMESTAMP(3) NOT NULL,
    "leaseExpiresAt" TIMESTAMP(3),
    "controlOwner" TEXT NOT NULL DEFAULT 'agent',
    "attentionRequestId" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IPhoneLease_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IPhoneDevice_userId_key" ON "IPhoneDevice"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "IPhoneDevice_providerDeviceId_key" ON "IPhoneDevice"("providerDeviceId");

-- CreateIndex
CREATE UNIQUE INDEX "IPhoneLease_ticket_key" ON "IPhoneLease"("ticket");

-- CreateIndex
CREATE UNIQUE INDEX "IPhoneLease_activeDeviceId_key" ON "IPhoneLease"("activeDeviceId");

-- CreateIndex
CREATE INDEX "IPhoneLease_deviceId_status_ticket_idx" ON "IPhoneLease"("deviceId", "status", "ticket");

-- CreateIndex
CREATE INDEX "IPhoneLease_deviceId_status_queueDeadlineAt_idx" ON "IPhoneLease"("deviceId", "status", "queueDeadlineAt");

-- CreateIndex
CREATE INDEX "IPhoneLease_deviceId_status_leaseExpiresAt_idx" ON "IPhoneLease"("deviceId", "status", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "IPhoneLease_userId_idx" ON "IPhoneLease"("userId");

-- CreateIndex
CREATE INDEX "IPhoneLease_agentId_idx" ON "IPhoneLease"("agentId");

-- CreateIndex
CREATE UNIQUE INDEX "IPhoneLease_deviceId_agentId_requestKey_key" ON "IPhoneLease"("deviceId", "agentId", "requestKey");

-- AddForeignKey
ALTER TABLE "IPhoneDevice" ADD CONSTRAINT "IPhoneDevice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IPhoneLease" ADD CONSTRAINT "IPhoneLease_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "IPhoneDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IPhoneLease" ADD CONSTRAINT "IPhoneLease_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IPhoneLease" ADD CONSTRAINT "IPhoneLease_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;


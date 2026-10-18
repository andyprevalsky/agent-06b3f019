-- AlterTable
ALTER TABLE "IPhoneDevice" ADD COLUMN     "providerEpoch" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "providerSessionEncrypted" TEXT,
ADD COLUMN     "providerSessionId" TEXT,
ADD COLUMN     "providerStartKey" TEXT,
ADD COLUMN     "providerState" TEXT NOT NULL DEFAULT 'IDLE';

-- AlterTable
ALTER TABLE "IPhoneLease" ADD COLUMN     "releaseRequestedAt" TIMESTAMP(3),
ADD COLUMN     "releaseStatus" TEXT;

-- CreateTable
CREATE TABLE "IPhoneOperation" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "leaseId" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "requestEncrypted" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'CONNECTING',
    "activeDeviceId" TEXT,
    "providerEpoch" INTEGER NOT NULL,
    "deadlineAt" TIMESTAMP(3) NOT NULL,
    "resultEncrypted" TEXT,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "IPhoneOperation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IPhoneOperation_activeDeviceId_key" ON "IPhoneOperation"("activeDeviceId");

-- CreateIndex
CREATE INDEX "IPhoneOperation_deviceId_state_deadlineAt_idx" ON "IPhoneOperation"("deviceId", "state", "deadlineAt");

-- CreateIndex
CREATE INDEX "IPhoneOperation_leaseId_createdAt_idx" ON "IPhoneOperation"("leaseId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "IPhoneOperation_leaseId_requestKey_key" ON "IPhoneOperation"("leaseId", "requestKey");

-- AddForeignKey
ALTER TABLE "IPhoneOperation" ADD CONSTRAINT "IPhoneOperation_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "IPhoneDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IPhoneOperation" ADD CONSTRAINT "IPhoneOperation_leaseId_fkey" FOREIGN KEY ("leaseId") REFERENCES "IPhoneLease"("id") ON DELETE CASCADE ON UPDATE CASCADE;

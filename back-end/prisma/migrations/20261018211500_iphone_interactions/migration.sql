-- AlterTable
ALTER TABLE "IPhoneLease" ADD COLUMN     "actionCursor" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastOperationId" TEXT;

-- AlterTable
ALTER TABLE "IPhoneOperation" ADD COLUMN     "cursor" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "IPhoneAcquireIntent" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "browserTaskId" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "leaseId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IPhoneAcquireIntent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IPhoneAcquireIntent_leaseId_idx" ON "IPhoneAcquireIntent"("leaseId");

-- CreateIndex
CREATE UNIQUE INDEX "IPhoneAcquireIntent_deviceId_browserTaskId_requestKey_key" ON "IPhoneAcquireIntent"("deviceId", "browserTaskId", "requestKey");

-- CreateIndex
CREATE INDEX "IPhoneLease_deviceId_browserTaskId_ticket_idx" ON "IPhoneLease"("deviceId", "browserTaskId", "ticket");

-- AddForeignKey
ALTER TABLE "IPhoneAcquireIntent" ADD CONSTRAINT "IPhoneAcquireIntent_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "IPhoneDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IPhoneAcquireIntent" ADD CONSTRAINT "IPhoneAcquireIntent_leaseId_fkey" FOREIGN KEY ("leaseId") REFERENCES "IPhoneLease"("id") ON DELETE CASCADE ON UPDATE CASCADE;

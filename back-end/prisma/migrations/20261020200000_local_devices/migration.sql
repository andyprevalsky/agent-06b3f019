-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "originDeviceId" TEXT;

-- CreateTable
CREATE TABLE "LocalDevice" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'darwin',
    "appVersion" TEXT,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LocalDevice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LocalDevice_userId_idx" ON "LocalDevice"("userId");

-- AddForeignKey
ALTER TABLE "LocalDevice" ADD CONSTRAINT "LocalDevice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backend-only bookkeeping: the service role owns every read and write
-- (the Mac app and web client go through the authenticated API), so no client
-- policy is granted.
ALTER TABLE "LocalDevice" ENABLE ROW LEVEL SECURITY;

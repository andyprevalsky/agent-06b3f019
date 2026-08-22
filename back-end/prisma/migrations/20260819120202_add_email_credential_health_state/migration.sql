-- AlterTable
ALTER TABLE "EmailIntegrationCredential" ADD COLUMN     "lastErrorReason" TEXT,
ADD COLUMN     "lastFailedSyncAt" TIMESTAMP(3),
ADD COLUMN     "state" TEXT NOT NULL DEFAULT 'connected';


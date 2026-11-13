-- AlterTable
ALTER TABLE "Integration" ADD COLUMN     "usageSource" TEXT,
ADD COLUMN     "usageStatus" TEXT,
ADD COLUMN     "rateLimitReason" TEXT,
ADD COLUMN     "rateLimitAuthoritative" BOOLEAN;

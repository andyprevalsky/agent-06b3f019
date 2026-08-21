-- AlterTable
ALTER TABLE "ComputeAccountConnection" ADD COLUMN     "poolingEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "poolingEnabledOverride" BOOLEAN;

-- AlterTable
ALTER TABLE "ComputeGrant" ADD COLUMN     "rateLimitedUntil" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "ComputeGrant_status_rateLimitedUntil_idx" ON "ComputeGrant"("status", "rateLimitedUntil");

